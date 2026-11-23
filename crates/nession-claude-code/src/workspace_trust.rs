//! Claude Code Workspace Trust preparation (#4073).
//!
//! Nession creates a Session in a directory it was explicitly asked to use, and
//! an unattended `claude.enter` must not stop on Claude's first-run Workspace
//! Trust dialog. The capability therefore records the same acceptance Claude
//! records when a person clicks "Yes, I trust this folder": in Claude's global
//! state file,
//!
//! ```json
//! { "projects": { "<project root>": { "hasTrustDialogAccepted": true } } }
//! ```
//!
//! ## Ownership
//!
//! | Fact | Owner |
//! | --- | --- |
//! | Session working directory and Claude environment | the Agent host (`SessionContext`) |
//! | Trust key, state-file decision, merge and write | this module |
//!
//! The Agent host never decides trust itself: it supplies the live Session
//! facts at creation and again immediately before `claude.enter`, and this
//! module fails closed whenever those facts cannot be verified. A Session is
//! never given a generic Claude settings field, and nothing here is a second
//! Nession trust registry — the only durable record is Claude's own file.
//!
//! ## Upstream shape (measured, not assumed)
//!
//! Claude Code stores the answer per project in the global configuration:
//! `projects[<project dir>].hasTrustDialogAccepted` is read by the CLI's
//! workspace-trust resolver, and a project entry also carries
//! `allowedTools`, `mcpServers`, `enabledMcpjsonServers` and
//! `disabledMcpjsonServers`. The key is the project directory Claude resolves
//! from the launch cwd; for a Git working tree that is the repository root, and
//! for a linked worktree it is the main working copy (the same identity
//! [`crate::memory`] resolves for Auto Memory). The state file is
//! `<home>/.claude.json`, or `<CLAUDE_CONFIG_DIR>/.claude.json` when the Session
//! sets a config dir — the location [`crate::mcp::config::resolve_roots`] owns
//! and this module consumes.
//!
//! The field and file were verified against the Claude Code 2.1.329 binary
//! (`hasTrustDialogAccepted` in the project-entry reader and writer) and the
//! repository's measured 2.1.325 state-file layout. The agent image pins
//! 2.1.323. An incompatible future storage shape is not guessed at: a file
//! whose top-level document, `projects` member or project entry has the wrong
//! JSON type is refused, and the live staging smoke is what observes whether
//! the running CLI still renders the dialog.
//!
//! ## What this deliberately does not do
//!
//! Workspace Trust is *not* tool permission. This module writes exactly one
//! boolean under the Session's own project entry: it never adds permission
//! rules, never preapproves an MCP server, never changes `allowedTools` or
//! `enabledMcpjsonServers`, and never edits another project's entry. Trust may
//! already exist for an ancestor directory; that is Claude's lookup rule, not a
//! reason to widen what Nession writes.
//!
//! ## Authorization boundary
//!
//! The only directory this module can trust is the one the host resolved as the
//! Session's live working directory. There is no path argument on any wire,
//! no MCP tool that names a trust path, and no caller-provided root. The
//! resolved key must be a real directory and must not be the Claude home
//! directory or one of its ancestors: Claude records home-directory trust for
//! one session only, so writing there would claim a protection that does not
//! exist. Everything else fails with a specific [`TrustError`] instead of
//! guessing.
//!
//! ## Durability and concurrency
//!
//! Writes merge into the existing document, are serialised across processes
//! sharing one Claude home by an advisory lock on a sidecar file, and replace
//! the state file with a same-directory temporary file plus `rename` so an
//! interrupted write can never leave truncated JSON. An existing file's
//! permission bits are preserved; a new file is created private (`0600`). The
//! sidecar lock is never removed — deleting it would break mutual exclusion.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{Map, Value};
use unicode_normalization::UnicodeNormalization;

use crate::mcp::config::{read_json, resolve_roots, Roots, SourceRead};
use crate::memory::repository_identity;
use crate::session_context::SessionContext;

/// The project-entry field Claude reads before it shows the trust dialog.
const TRUST_FIELD: &str = "hasTrustDialogAccepted";

/// The `projects` member of Claude's global configuration.
const PROJECTS_FIELD: &str = "projects";

/// Sidecar lock file beside the state file.
const LOCK_SUFFIX: &str = ".nession-trust.lock";

/// How many temporary names this process has issued.
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// The result of a successful preparation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedTrust {
    /// The canonical project root whose trust was accepted.
    pub root: PathBuf,
    /// The Claude state file the acceptance was merged into.
    pub state_file: PathBuf,
    /// `false` when the entry was already trusted and nothing was rewritten.
    pub changed: bool,
}

/// Why Workspace Trust could not be prepared.
///
/// Every variant names the boundary that failed. The message never includes
/// file contents, so no unrelated Claude configuration or credential can reach
/// a Nession log or tool reply through an error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrustError {
    /// The host could not name the Session, its working directory or its
    /// Claude environment.
    Unavailable(String),
    /// The host answered, but with a value this resolver cannot use.
    Invalid(String),
    /// The resolved directory is not one Nession may trust for this Session.
    Unauthorized(String),
    /// The existing state file is not a shape this capability understands.
    Malformed(String),
    /// The state file exists but could not be read.
    Unreadable(String),
    /// The merged document could not be written atomically.
    WriteFailed(String),
}

impl std::fmt::Display for TrustError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(reason) => write!(formatter, "session context unavailable: {reason}"),
            Self::Invalid(reason) => write!(formatter, "session context invalid: {reason}"),
            Self::Unauthorized(reason) => write!(formatter, "refused: {reason}"),
            Self::Malformed(reason) => write!(formatter, "malformed Claude state file: {reason}"),
            Self::Unreadable(reason) => write!(formatter, "unreadable Claude state file: {reason}"),
            Self::WriteFailed(reason) => write!(formatter, "write failed: {reason}"),
        }
    }
}

impl std::error::Error for TrustError {}

/// Resolve and prepare one Session's Workspace Trust.
///
/// `context` is the Agent host's view of the Session. The working directory is
/// re-read on every call — never cached from creation — so a Session that moved
/// is prepared for the directory it is in now. A host that cannot answer is a
/// specific failure, not a default.
pub async fn prepare_session(
    context: &dyn SessionContext,
    session_id: &str,
) -> Result<PreparedTrust, TrustError> {
    let roots = resolve_roots(context, session_id)
        .await
        .map_err(|error| match error {
            crate::mcp::config::ContextError::Unavailable(reason) => {
                TrustError::Unavailable(reason.to_string())
            }
            crate::mcp::config::ContextError::Invalid(reason) => TrustError::Invalid(reason),
        })?;
    let target = TrustTarget::resolve(&roots)?;
    tokio::task::spawn_blocking(move || target.prepare())
        .await
        .map_err(|error| TrustError::WriteFailed(format!("the preparation task ended: {error}")))?
}

/// The capability handle a host composes once and shares.
#[derive(Clone)]
pub struct WorkspaceTrust {
    session: Arc<dyn SessionContext>,
}

impl WorkspaceTrust {
    /// Bind the capability to one host's Session view.
    pub fn new(session: Arc<dyn SessionContext>) -> Self {
        Self { session }
    }

    /// Prepare the trust acceptance for `session_id`.
    pub async fn prepare(&self, session_id: &str) -> Result<PreparedTrust, TrustError> {
        prepare_session(self.session.as_ref(), session_id).await
    }
}

/// The exact file and project key one Session's trust acceptance targets.
#[derive(Debug, Clone, PartialEq, Eq)]
struct TrustTarget {
    root: PathBuf,
    state_file: PathBuf,
}

impl TrustTarget {
    /// Derive the target from the host's resolved Session roots.
    ///
    /// This is the authorization decision: the key comes from the live cwd, and
    /// a directory that is the Claude home (or contains it) is refused.
    fn resolve(roots: &Roots) -> Result<Self, TrustError> {
        let cwd = fs::canonicalize(&roots.canonical_cwd).map_err(|error| {
            TrustError::Unavailable(format!(
                "the Session working directory `{}` cannot be resolved: {error}",
                roots.canonical_cwd.display()
            ))
        })?;
        if !cwd.is_dir() {
            return Err(TrustError::Unavailable(format!(
                "the Session working directory `{}` is not a directory",
                cwd.display()
            )));
        }

        let identity = repository_identity(&cwd)
            .map_err(|error| TrustError::Unavailable(format!("repository identity: {error}")))?;
        let root = fs::canonicalize(&identity.root).map_err(|error| {
            TrustError::Unavailable(format!(
                "the project root `{}` cannot be resolved: {error}",
                identity.root.display()
            ))
        })?;
        if !root.is_dir() {
            return Err(TrustError::Unavailable(format!(
                "the project root `{}` is not a directory",
                root.display()
            )));
        }

        let home = fs::canonicalize(&roots.home).map_err(|error| {
            TrustError::Unavailable(format!(
                "the Claude home `{}` cannot be resolved: {error}",
                roots.home.display()
            ))
        })?;
        // Claude records home trust for one session only. Trusting the home or
        // an ancestor would also blanket-trust every directory beneath it, so
        // this is the one root Nession refuses even though the Session named it.
        if home.starts_with(&root) {
            return Err(TrustError::Unauthorized(format!(
                "the project root `{}` is the Claude home directory or one of its ancestors; \
                 Claude does not persist trust there",
                root.display()
            )));
        }

        Ok(Self {
            root,
            state_file: roots.state_file.clone(),
        })
    }

    /// The `projects` key Claude resolves for this root.
    fn project_key(&self) -> String {
        self.root.to_string_lossy().nfc().collect()
    }

    /// Merge and persist the acceptance.
    fn prepare(&self) -> Result<PreparedTrust, TrustError> {
        let state_file = resolve_state_file(&self.state_file)?;
        let parent = state_file.parent().ok_or_else(|| {
            TrustError::WriteFailed(format!(
                "the state file `{}` has no parent directory",
                state_file.display()
            ))
        })?;
        fs::create_dir_all(parent).map_err(|error| {
            TrustError::WriteFailed(format!(
                "the Claude configuration directory `{}` could not be created: {error}",
                parent.display()
            ))
        })?;

        let _lock = TrustLock::acquire(&lock_path(&state_file))?;
        let existing = read_state(&state_file)?;
        let mut document = match existing {
            Some((document, permissions)) => (document, permissions),
            None => (Value::Object(Map::new()), None),
        };
        let changed = merge(&mut document.0, &self.project_key())?;
        if !changed {
            return Ok(PreparedTrust {
                root: self.root.clone(),
                state_file,
                changed: false,
            });
        }
        write_atomically(&state_file, &document.0, document.1)?;
        Ok(PreparedTrust {
            root: self.root.clone(),
            state_file,
            changed: true,
        })
    }
}

/// Follow an existing state file through symlinks so a linked configuration is
/// updated in place rather than replaced by a regular file.
fn resolve_state_file(state_file: &Path) -> Result<PathBuf, TrustError> {
    match fs::symlink_metadata(state_file) {
        Ok(_) => fs::canonicalize(state_file).map_err(|error| {
            TrustError::Unreadable(format!(
                "{} cannot be resolved: {error}",
                state_file.display()
            ))
        }),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(state_file.to_path_buf())
        }
        Err(error) => Err(TrustError::Unreadable(format!(
            "{}: {error}",
            state_file.display()
        ))),
    }
}

/// Read the existing document, preserving its permission bits.
fn read_state(state_file: &Path) -> Result<Option<(Value, Option<fs::Permissions>)>, TrustError> {
    match read_json(state_file) {
        SourceRead::Missing => Ok(None),
        SourceRead::Read(document) => {
            if !document.is_object() {
                return Err(TrustError::Malformed(format!(
                    "{} has no JSON object at the top level",
                    state_file.display()
                )));
            }
            let permissions = fs::metadata(state_file)
                .ok()
                .map(|metadata| metadata.permissions());
            Ok(Some((document, permissions)))
        }
        SourceRead::Error(detail) => Err(TrustError::Unreadable(format!(
            "{}: {detail}",
            state_file.display()
        ))),
    }
}

/// Set only the Session's trust acceptance. Returns whether anything changed.
fn merge(document: &mut Value, key: &str) -> Result<bool, TrustError> {
    let object = document.as_object_mut().ok_or_else(|| {
        TrustError::Malformed("the top-level document is not an object".to_string())
    })?;
    if !object.contains_key(PROJECTS_FIELD) {
        object.insert(PROJECTS_FIELD.to_string(), Value::Object(Map::new()));
    }
    let projects = object
        .get_mut(PROJECTS_FIELD)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| TrustError::Malformed(format!("`{PROJECTS_FIELD}` is not an object")))?;

    match projects.get_mut(key) {
        None => {
            let mut entry = Map::new();
            entry.insert(TRUST_FIELD.to_string(), Value::Bool(true));
            projects.insert(key.to_string(), Value::Object(entry));
            Ok(true)
        }
        Some(Value::Object(entry)) => match entry.get(TRUST_FIELD) {
            Some(Value::Bool(true)) => Ok(false),
            Some(Value::Bool(false)) | None => {
                entry.insert(TRUST_FIELD.to_string(), Value::Bool(true));
                Ok(true)
            }
            Some(_) => Err(TrustError::Malformed(format!(
                "`{PROJECTS_FIELD}[\"{key}\"].{TRUST_FIELD}` is not a boolean"
            ))),
        },
        Some(_) => Err(TrustError::Malformed(format!(
            "`{PROJECTS_FIELD}[\"{key}\"]` is not an object"
        ))),
    }
}

/// Replace the state file with `document` atomically.
fn write_atomically(
    state_file: &Path,
    document: &Value,
    permissions: Option<fs::Permissions>,
) -> Result<(), TrustError> {
    let directory = state_file.parent().ok_or_else(|| {
        TrustError::WriteFailed(format!(
            "the state file `{}` has no parent directory",
            state_file.display()
        ))
    })?;
    let mut body = serde_json::to_vec_pretty(document).map_err(|error| {
        TrustError::WriteFailed(format!(
            "the Claude state document cannot be serialised: {error}"
        ))
    })?;
    body.push(b'\n');

    let temporary = temporary_path(directory);
    let result = (|| -> io::Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        secure_mode(&mut options);
        let mut file = options.open(&temporary)?;
        file.write_all(&body)?;
        file.sync_all()?;
        drop(file);
        if let Some(permissions) = permissions {
            fs::set_permissions(&temporary, permissions)?;
        }
        fs::rename(&temporary, state_file)
    })();

    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(TrustError::WriteFailed(format!(
            "{}: {error}",
            state_file.display()
        )));
    }

    // The rename is atomic; syncing the directory makes the directory entry
    // durable too, so a crash after the reply cannot lose the acceptance.
    if let Ok(directory) = File::open(directory) {
        let _ = directory.sync_all();
    }
    Ok(())
}

/// A same-directory name `create_new` has never handed out.
fn temporary_path(directory: &Path) -> PathBuf {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    directory.join(format!(".nea-trust-{}-{sequence}.tmp", std::process::id()))
}

fn lock_path(state_file: &Path) -> PathBuf {
    let mut name = state_file.as_os_str().to_os_string();
    name.push(LOCK_SUFFIX);
    PathBuf::from(name)
}

/// Give a newly created file private permissions.
fn secure_mode(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    {
        let _ = options;
    }
}

/// An exclusive advisory lock held across read-merge-write.
struct TrustLock {
    _file: File,
}

impl TrustLock {
    fn acquire(path: &Path) -> Result<Self, TrustError> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        secure_mode(&mut options);
        let file = options.open(path).map_err(|error| {
            TrustError::WriteFailed(format!(
                "the trust lock `{}` could not be opened: {error}",
                path.display()
            ))
        })?;
        lock_exclusive(&file).map_err(|error| {
            TrustError::WriteFailed(format!(
                "the trust lock `{}` could not be acquired: {error}",
                path.display()
            ))
        })?;
        Ok(Self { _file: file })
    }
}

#[cfg(unix)]
impl Drop for TrustLock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // SAFETY: `self._file` owns a valid descriptor for the duration of the
        // call. The explicit unlock matches the CLI lifecycle lock: a child
        // that inherited this description must not keep the lock after us.
        let _ = unsafe { libc::flock(self._file.as_raw_fd(), libc::LOCK_UN) };
    }
}

#[cfg(unix)]
fn lock_exclusive(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    // SAFETY: `file` owns a valid descriptor for the duration of the call.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(not(unix))]
fn lock_exclusive(_file: &File) -> io::Result<()> {
    // Sessions are a Unix/tmux product; a non-Unix host has no `flock`. The
    // write is still atomic; only cross-process serialisation is unavailable.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_context::SessionClaudeConfig;
    use std::sync::Mutex;

    struct FixedContext {
        cwd: Mutex<String>,
        config: Option<SessionClaudeConfig>,
    }

    impl FixedContext {
        fn new(cwd: &Path, home: &Path) -> Self {
            Self {
                cwd: Mutex::new(cwd.to_string_lossy().into_owned()),
                config: Some(SessionClaudeConfig {
                    home: Some(home.to_string_lossy().into_owned()),
                    ..SessionClaudeConfig::default()
                }),
            }
        }

        fn with_config(cwd: &Path, config: SessionClaudeConfig) -> Self {
            Self {
                cwd: Mutex::new(cwd.to_string_lossy().into_owned()),
                config: Some(config),
            }
        }
    }

    #[async_trait::async_trait]
    impl SessionContext for FixedContext {
        async fn session_cwd(&self, _session_id: &str) -> Option<String> {
            Some(self.cwd.lock().expect("cwd").clone())
        }

        async fn session_claude_config(&self, _session_id: &str) -> Option<SessionClaudeConfig> {
            self.config.clone()
        }

        async fn session_claude_active(&self, _session_id: &str) -> Option<bool> {
            Some(false)
        }

        async fn session_claude_binding(
            &self,
            _session_id: &str,
        ) -> Option<crate::binding::Binding> {
            None
        }
    }

    fn home(temp: &tempfile::TempDir) -> PathBuf {
        let home = temp.path().join("home");
        fs::create_dir_all(&home).expect("home");
        home
    }

    fn project(temp: &tempfile::TempDir, name: &str, git: bool) -> PathBuf {
        let root = temp.path().join(name);
        fs::create_dir_all(&root).expect("project");
        if git {
            fs::create_dir_all(root.join(".git")).expect("git dir");
        }
        root
    }

    fn document(path: &Path) -> Value {
        serde_json::from_slice(&fs::read(path).expect("state file")).expect("valid JSON")
    }

    fn key_of(path: &Path) -> String {
        fs::canonicalize(path)
            .expect("canonical project")
            .to_string_lossy()
            .nfc()
            .collect()
    }

    #[tokio::test]
    async fn a_git_repository_is_keyed_by_its_root() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let root = project(&temp, "repo", true);
        let nested = root.join("src/deep");
        fs::create_dir_all(&nested).expect("nested");

        let prepared = prepare_session(&FixedContext::new(&nested, &home), "agent:dev")
            .await
            .expect("prepared");
        assert_eq!(
            prepared.root,
            fs::canonicalize(&root).expect("canonical root")
        );
        assert!(prepared.changed);
        let state = document(&home.join(".claude.json"));
        assert_eq!(
            state[PROJECTS_FIELD][key_of(&root)][TRUST_FIELD],
            Value::Bool(true)
        );
    }

    #[tokio::test]
    async fn a_linked_worktree_is_keyed_by_the_main_working_copy() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let main = temp.path().join("main");
        let worktree = temp.path().join("wt");
        fs::create_dir_all(main.join(".git/worktrees/wt")).expect("git worktrees");
        fs::create_dir_all(&worktree).expect("worktree");
        let git_dir = main.join(".git/worktrees/wt");
        fs::write(git_dir.join("commondir"), "../..\n").expect("commondir");
        fs::write(
            git_dir.join("gitdir"),
            worktree.join(".git").to_string_lossy().as_bytes(),
        )
        .expect("back pointer");
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", git_dir.display()),
        )
        .expect("git file");

        prepare_session(&FixedContext::new(&worktree, &home), "agent:dev")
            .await
            .expect("prepared");
        let state = document(&home.join(".claude.json"));
        assert_eq!(
            state[PROJECTS_FIELD][key_of(&main)][TRUST_FIELD],
            Value::Bool(true),
            "the main working copy is shared by every worktree"
        );
        assert!(state[PROJECTS_FIELD].get(key_of(&worktree)).is_none());
    }

    #[tokio::test]
    async fn a_non_git_directory_is_keyed_by_the_working_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let project = project(&temp, "plain", false);

        prepare_session(&FixedContext::new(&project, &home), "agent:dev")
            .await
            .expect("prepared");
        let state = document(&home.join(".claude.json"));
        assert_eq!(
            state[PROJECTS_FIELD][key_of(&project)][TRUST_FIELD],
            Value::Bool(true)
        );
    }

    #[tokio::test]
    async fn a_custom_config_dir_moves_the_state_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let project = project(&temp, "repo", true);
        let config_dir = home.join("custom-claude");
        let context = FixedContext::with_config(
            &project,
            SessionClaudeConfig {
                home: Some(home.to_string_lossy().into_owned()),
                config_dir: Some(config_dir.to_string_lossy().into_owned()),
                ..SessionClaudeConfig::default()
            },
        );

        prepare_session(&context, "agent:dev")
            .await
            .expect("prepared");
        let state = document(&config_dir.join(".claude.json"));
        assert_eq!(
            state[PROJECTS_FIELD][key_of(&project)][TRUST_FIELD],
            Value::Bool(true)
        );
        assert!(!home.join(".claude.json").exists());
    }

    #[tokio::test]
    async fn a_repeated_preparation_is_idempotent() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let project = project(&temp, "repo", true);
        let state_path = home.join(".claude.json");
        fs::write(
            &state_path,
            serde_json::json!({
                "numStartups": 7,
                "projects": {
                    "/somewhere/else": { "hasTrustDialogAccepted": true, "allowedTools": ["Bash"] }
                }
            })
            .to_string(),
        )
        .expect("seed state");
        let before = fs::read(&state_path).expect("seed read");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&state_path, fs::Permissions::from_mode(0o640)).expect("mode");
        }

        let context = FixedContext::new(&project, &home);
        let first = prepare_session(&context, "agent:dev").await.expect("first");
        assert!(first.changed);
        let second = prepare_session(&context, "agent:dev")
            .await
            .expect("second");
        assert!(!second.changed);

        let state = document(&state_path);
        assert_eq!(
            state["projects"]["/somewhere/else"]["allowedTools"],
            serde_json::json!(["Bash"])
        );
        assert_eq!(state["numStartups"], 7);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&state_path)
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o640, "the existing file's permissions are preserved");
        }
        assert_ne!(before, fs::read(&state_path).expect("read"));
    }

    #[tokio::test]
    async fn a_new_state_file_is_private() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let project = project(&temp, "repo", true);
        prepare_session(&FixedContext::new(&project, &home), "agent:dev")
            .await
            .expect("prepared");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(home.join(".claude.json"))
                .expect("metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "a created state file is private");
        }
    }

    #[tokio::test]
    async fn unrelated_configuration_and_other_projects_are_untouched() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let project = project(&temp, "repo", true);
        let state_path = home.join(".claude.json");
        let original = serde_json::json!({
            "numStartups": 7,
            "hasCompletedOnboarding": true,
            "oauthAccount": { "emailAddress": "fixture@example.invalid" },
            "mcpServers": { "user-db": { "command": "db-mcp" } },
            "projects": {
                "/somewhere/else": {
                    "hasTrustDialogAccepted": false,
                    "allowedTools": ["Bash(git status)"],
                    "enabledMcpjsonServers": ["other"]
                },
                key_of(&project): {
                    "hasTrustDialogAccepted": false,
                    "allowedTools": ["Read"],
                    "mcpServers": { "local": { "command": "local-mcp" } },
                    "enabledMcpjsonServers": ["project-server"],
                    "disabledMcpjsonServers": ["blocked-server"]
                }
            }
        });
        fs::write(&state_path, original.to_string()).expect("seed");

        prepare_session(&FixedContext::new(&project, &home), "agent:dev")
            .await
            .expect("prepared");
        let after = document(&state_path);
        let mut expected = original.clone();
        expected["projects"][key_of(&project)][TRUST_FIELD] = Value::Bool(true);

        assert_eq!(
            after, expected,
            "only the verified project's trust flag changed"
        );
        assert_eq!(
            after["projects"]["/somewhere/else"][TRUST_FIELD],
            Value::Bool(false)
        );
        assert!(
            after.get("permissionMode").is_none(),
            "trust preparation introduces no permission mode"
        );
    }

    #[tokio::test]
    async fn malformed_json_is_reported_and_never_rewritten() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let project = project(&temp, "repo", true);
        let state_path = home.join(".claude.json");
        fs::write(&state_path, "{ not json").expect("seed");
        let before = fs::read(&state_path).expect("read");

        let error = prepare_session(&FixedContext::new(&project, &home), "agent:dev")
            .await
            .expect_err("malformed");
        assert!(matches!(error, TrustError::Unreadable(_)), "{error}");
        assert_eq!(before, fs::read(&state_path).expect("read"));
    }

    #[tokio::test]
    async fn a_wrongly_typed_projects_member_is_reported() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let project = project(&temp, "repo", true);
        let key = key_of(&project);
        for seed in [
            serde_json::json!({ "projects": [] }),
            serde_json::json!({ "projects": { key.clone(): null } }),
            serde_json::json!({ "projects": { key.clone(): { "hasTrustDialogAccepted": "yes" } } }),
        ] {
            let state_path = home.join(".claude.json");
            fs::write(&state_path, seed.to_string()).expect("seed");
            let before = fs::read(&state_path).expect("read");
            let error = prepare_session(&FixedContext::new(&project, &home), "agent:dev")
                .await
                .expect_err("malformed shape");
            assert!(matches!(error, TrustError::Malformed(_)), "{error}");
            assert_eq!(before, fs::read(&state_path).expect("read"));
        }
    }

    #[tokio::test]
    async fn the_home_directory_is_refused() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let error = prepare_session(&FixedContext::new(&home, &home), "agent:dev")
            .await
            .expect_err("home");
        assert!(matches!(error, TrustError::Unauthorized(_)), "{error}");
        assert!(!home.join(".claude.json").exists());
    }

    #[tokio::test]
    async fn an_ancestor_of_the_home_directory_is_refused() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("checkout");
        let home = root.join("home");
        fs::create_dir_all(root.join(".git")).expect("git");
        fs::create_dir_all(&home).expect("home");
        let error = prepare_session(&FixedContext::new(&root, &home), "agent:dev")
            .await
            .expect_err("ancestor");
        assert!(matches!(error, TrustError::Unauthorized(_)), "{error}");
    }

    #[tokio::test]
    async fn an_unobservable_session_writes_nothing() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let project = project(&temp, "repo", true);
        let context = FixedContext {
            cwd: Mutex::new(project.to_string_lossy().into_owned()),
            config: None,
        };
        let error = prepare_session(&context, "agent:dev")
            .await
            .expect_err("no config");
        assert!(matches!(error, TrustError::Unavailable(_)), "{error}");
        assert!(!home.join(".claude.json").exists());
    }

    #[tokio::test]
    async fn a_relative_config_dir_is_refused() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let project = project(&temp, "repo", true);
        let context = FixedContext::with_config(
            &project,
            SessionClaudeConfig {
                home: Some(home.to_string_lossy().into_owned()),
                config_dir: Some("relative/claude".to_string()),
                ..SessionClaudeConfig::default()
            },
        );
        let error = prepare_session(&context, "agent:dev")
            .await
            .expect_err("relative config dir");
        assert!(matches!(error, TrustError::Invalid(_)), "{error}");
        assert!(!home.join(".claude.json").exists());
    }

    #[tokio::test]
    async fn every_call_re_resolves_the_live_working_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let first = project(&temp, "first", true);
        let second = project(&temp, "second", true);
        let context = FixedContext::new(&first, &home);

        prepare_session(&context, "agent:dev").await.expect("first");
        *context.cwd.lock().expect("cwd") = second.to_string_lossy().into_owned();
        prepare_session(&context, "agent:dev")
            .await
            .expect("second");

        let state = document(&home.join(".claude.json"));
        assert_eq!(
            state[PROJECTS_FIELD][key_of(&first)][TRUST_FIELD],
            Value::Bool(true)
        );
        assert_eq!(
            state[PROJECTS_FIELD][key_of(&second)][TRUST_FIELD],
            Value::Bool(true)
        );
    }

    #[test]
    fn concurrent_preparations_converge_on_one_valid_document() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let targets: Vec<TrustTarget> = (0..8)
            .map(|index| {
                let repository = project(&temp, &format!("repo-{index}"), true);
                TrustTarget {
                    root: fs::canonicalize(&repository).expect("canonical"),
                    state_file: home.join(".claude.json"),
                }
            })
            .collect();
        fs::write(
            home.join(".claude.json"),
            serde_json::json!({
                "numStartups": 1,
                "projects": { "/existing": { "hasTrustDialogAccepted": true } }
            })
            .to_string(),
        )
        .expect("seed");

        std::thread::scope(|scope| {
            for target in &targets {
                scope.spawn(move || {
                    target.prepare().expect("concurrent prepare");
                });
            }
        });

        let state = document(&home.join(".claude.json"));
        assert_eq!(state["numStartups"], 1);
        assert_eq!(
            state["projects"]["/existing"][TRUST_FIELD],
            Value::Bool(true)
        );
        for target in &targets {
            let key = target.root.to_string_lossy().nfc().collect::<String>();
            assert_eq!(
                state[PROJECTS_FIELD][key][TRUST_FIELD],
                Value::Bool(true),
                "every concurrent writer's project is present"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_symlinked_working_directory_is_resolved_to_the_real_project() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let root = project(&temp, "repo", true);
        let link = temp.path().join("linked");
        std::os::unix::fs::symlink(&root, &link).expect("symlink");

        let prepared = prepare_session(&FixedContext::new(&link, &home), "agent:dev")
            .await
            .expect("prepared");
        assert_eq!(prepared.root, fs::canonicalize(&root).expect("canonical"));
        let state = document(&home.join(".claude.json"));
        assert_eq!(
            state[PROJECTS_FIELD][key_of(&root)][TRUST_FIELD],
            Value::Bool(true)
        );
    }

    #[test]
    fn concurrent_preparations_of_one_project_converge() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let repository = project(&temp, "repo", true);
        let target = TrustTarget {
            root: fs::canonicalize(&repository).expect("canonical"),
            state_file: home.join(".claude.json"),
        };
        let changed = std::sync::atomic::AtomicUsize::new(0);

        std::thread::scope(|scope| {
            for _ in 0..4 {
                let target = target.clone();
                let changed = &changed;
                scope.spawn(move || {
                    if target.prepare().expect("concurrent prepare").changed {
                        changed.fetch_add(1, Ordering::Relaxed);
                    }
                });
            }
        });

        let state = document(&home.join(".claude.json"));
        assert_eq!(
            state[PROJECTS_FIELD][key_of(&repository)][TRUST_FIELD],
            Value::Bool(true)
        );
        assert_eq!(
            changed.load(Ordering::Relaxed),
            1,
            "exactly one writer installs the acceptance; the rest observe it"
        );
    }

    #[test]
    fn a_failed_replacement_never_destroys_the_existing_target() {
        let temp = tempfile::tempdir().expect("tempdir");
        let destination = temp.path().join("destination");
        fs::create_dir_all(&destination).expect("destination");
        fs::write(destination.join("kept"), "important").expect("kept file");

        let error = write_atomically(
            &destination,
            &serde_json::json!({ PROJECTS_FIELD: {} }),
            None,
        )
        .expect_err("rename onto a non-empty directory fails");
        assert!(matches!(error, TrustError::WriteFailed(_)), "{error}");
        assert_eq!(
            fs::read_to_string(destination.join("kept")).expect("kept"),
            "important"
        );
        let leftovers: Vec<_> = fs::read_dir(temp.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name())
            .filter(|name| name != "destination")
            .collect();
        assert!(
            leftovers.is_empty(),
            "no temporary file is left: {leftovers:?}"
        );
    }

    #[test]
    fn the_prepared_target_is_reported_on_a_failed_write() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = home(&temp);
        let project = project(&temp, "repo", true);
        let roots = Roots {
            cwd: project.clone(),
            canonical_cwd: fs::canonicalize(&project).expect("canonical"),
            home: home.clone(),
            config_dir: home.join(".claude"),
            config_dir_is_explicit: false,
            state_file: home.join("missing-parent/state.json"),
            project_file: project.join(".mcp.json"),
            managed_file: None,
        };
        let target = TrustTarget::resolve(&roots).expect("target");
        // The parent is a file, so directory creation fails before any write.
        fs::write(home.join("missing-parent"), "file, not a directory").expect("parent file");
        let error = target.prepare().expect_err("unwritable parent");
        assert!(matches!(error, TrustError::WriteFailed(_)), "{error}");
    }
}
