//! tmux session lifecycle management: create, list, and kill sessions.

use anyhow::{Context, Result};
use nession_protocol::contracts::env::v1::{EnvSnapshot, SessionEnvProfile};
use nession_protocol::contracts::sandbox::v1::{SandboxExecutionReport, SandboxPolicy};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use super::cmd::{self, TmuxCmd};
use super::env::{EffectiveOverlay, EnvManager, ShellAdapter};
use super::ops::{TmuxDep, TmuxOps};

/// The environment that tells a Claude Code integration which Nession session it
/// is in, and where to report what it is doing (`#1005`).
///
/// Injected into every session unconditionally. These two are the *only* things
/// the plugin's hook checks before it acts, and it acts by copying its stdin to
/// the named file — so a session that lacks them is one where Claude runs and
/// reports nothing, which is a binding that never appears rather than an error
/// anyone sees.
///
/// The path is fenced by the tmux Session instance (`#2974`): the same instance
/// id is delivered to the Session's environment and later stored as
/// [`INSTANCE_ID_OPTION`], so a delete/recreate of the same name reads and
/// writes a different file.
///
/// The derivation itself lives in [`crate::claude_binding`], which the reader
/// uses too; see that module for why it is shared rather than written out here.
/// See it also for why nothing is created here: the hook writes with `cat >`,
/// but giving session creation a filesystem side effect would put the
/// developer's real state directory in the path of every test that creates a
/// session. The agent creates it at startup, beside the plugin whose hook needs
/// it — the only time it can matter, because the hook cannot run before it is
/// installed. This function reads no filesystem.
fn claude_binding_env(session_name: &str, instance_id: &str) -> Vec<(String, String)> {
    crate::claude_binding::env_for(session_name, instance_id)
}

/// Resolve the shell a new Session will actually run.
///
/// tmux's own `default-shell` is the first authority: the adapter has to launch
/// the same shell tmux would. The Agent process's `SHELL` is next, and the
/// passwd login shell for this uid is the last fallback.
///
/// The last step is not cosmetic. The adapter is resolved *before* `new-session`
/// starts a tmux server, so a container image that sets neither `SHELL` nor a
/// tmux server yet makes the pre-session query answer empty even though tmux
/// resolves the passwd shell a moment later. Without this fallback the Session
/// runs bash while the binding reports `unsupported_shell` and Layer C is
/// skipped.
pub(super) fn resolve_session_shell(
    tmux_default: Option<String>,
    shell_env: Option<String>,
    passwd_shell: Option<String>,
) -> Option<String> {
    [tmux_default, shell_env, passwd_shell]
        .into_iter()
        .flatten()
        .map(|shell| shell.trim().to_string())
        .find(|shell| !shell.is_empty())
}

/// The login shell recorded for this process's uid in the passwd database.
///
/// Used only as a shell-resolution fallback. `None` when the database has no
/// entry or records a non-interactive shell.
#[cfg(unix)]
pub(super) fn passwd_login_shell() -> Option<String> {
    // SAFETY: `pwd` and `buf` are valid for the whole call, and `getpwuid_r`
    // writes the record and its strings into them. On success `pw_shell`
    // points into `buf`, and the string is copied out before either is
    // dropped. A non-zero return (including ERANGE) is "no answer".
    unsafe {
        let mut pwd: libc::passwd = std::mem::zeroed();
        let mut buf = vec![0; 4096];
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        let rc = libc::getpwuid_r(
            libc::getuid(),
            &mut pwd,
            buf.as_mut_ptr(),
            buf.len(),
            &mut result,
        );
        if rc != 0 || result.is_null() || pwd.pw_shell.is_null() {
            return None;
        }

        let shell = std::ffi::CStr::from_ptr(pwd.pw_shell)
            .to_string_lossy()
            .trim()
            .to_string();
        if shell.is_empty() || shell.ends_with("/nologin") || shell.ends_with("/false") {
            None
        } else {
            Some(shell)
        }
    }
}

#[cfg(not(unix))]
fn passwd_login_shell() -> Option<String> {
    None
}

/// Width a session is created at, **before any client has attached**.
///
/// A starting size, not a lock. tmux's `window-size` defaults to `latest` and
/// `create_session` deliberately leaves it unset (see `window_size_lock_tests`
/// at the bottom of this file), so the first client to attach resizes the
/// window to its own viewport and every later resize moves it again. There is
/// one window and one pane, shared by every attached client — a client that
/// does not fit scrolls, it does not get a viewport of its own.
///
/// That is the model decided in
/// `2026-08-15-viewport-fit-terminal-migration-design.md` §2
/// ("accept last-writer-wins … No arbitration"), which superseded the
/// fixed-size design this constant was originally sized for.
pub const SESSION_WIDTH: u16 = 200;

/// Default shell prompt injected into every tmux session so the K8s pod
/// hostname (e.g. `nession-agent-staging-84d4d8666f-zs5xj`) doesn't
/// clutter the terminal.  `\u` = user, `\w` = working dir, `\$` = # or $.
pub const DEFAULT_PS1: &str = r"\[\e[32m\]\u\[\e[0m\]:\[\e[34m\]\w\[\e[0m\]\$ ";

/// Height a session is created at, before any client has attached.
/// See [`SESSION_WIDTH`] — a starting size, not a lock.
pub const SESSION_HEIGHT: u16 = 60;

/// Timeout for quick tmux queries (`list-sessions`, `display-message`).
/// Must stay below the server's 3s force-refresh window so a slow list still
/// answers before the server marks the agent stale.
const TMUX_LIST_TIMEOUT: Duration = Duration::from_secs(2);

/// Timeout for `kill-session`.
const TMUX_KILL_TIMEOUT: Duration = Duration::from_secs(5);

/// Timeout for the multi-stage `create_session` (new-session + env setup).
const TMUX_CREATE_TIMEOUT: Duration = Duration::from_secs(10);

/// Timeout for reconciling a create whose deadline fired.
///
/// This is cleanup after the create budget is already spent; an unreconciled
/// answer is truthful, so it must not extend the caller's wait by another full
/// create budget.
const TMUX_CREATE_RECONCILE_TIMEOUT: Duration = Duration::from_secs(3);

/// The per-create ownership token, delivered to the Session's environment by
/// the same `new-session` operation that creates it (#2812).
///
/// A create can be cancelled while `new-session` is in flight — the outer
/// deadline drops the future, and the tmux child may still create the Session
/// afterwards. The token is what lets the reconciliation prove that a Session
/// appearing after the deadline is this attempt's, instead of guessing from
/// its name and killing a Session someone else owns. It is also reserved:
/// environment profiles cannot control `NESSON_*` keys.
const CREATE_TOKEN_ENV: &str = "NESSON_CREATE_TOKEN";

/// The environment variable carrying this tmux Session's instance identity.
///
/// Delivered by the same `new-session` that creates the Session, so a hook
/// started from that Session can be handed an instance-fenced binding file and
/// [`SessionManager::session_instance_id`] can adopt the *same* id when the
/// durable option is first read (`#2974`). A Session created before the fence
/// has no such variable, which is what lets the reader tell it apart from a
/// fenced Session whose binding is simply absent.
///
/// Reserved like every `NESSON_*` key ([`NEVER_FORWARDED_ENV`] and the env
/// profile policy), so neither a parent Nession Session nor a profile can
/// substitute one.
pub(crate) const INSTANCE_ID_ENV: &str = "NESSON_SESSION_INSTANCE_ID";

/// The tmux user option that durably stores a Session's instance identity
/// (`#2789`), beside the environment variable above.
const INSTANCE_ID_OPTION: &str = "@nession_instance_id";

/// Variables never forwarded from the agent process into a tmux session.
///
/// `TERM`/`LANG`/`LC_ALL` are forced explicitly below, whatever the host has.
///
/// `TMUX`/`TMUX_TMPDIR` describe whichever tmux server happened to start the
/// agent (they are set for every process inside a tmux pane). Forwarding them
/// makes every shell in a nession session believe it belongs to *that* server,
/// so a bare `tmux kill-server` typed inside a nession session would reach the
/// user's real sessions. nession addresses tmux by `-S` alone and passes none of
/// this on. [`CREATE_TOKEN_ENV`] is withheld for the other direction: an Agent
/// that itself runs inside a nession Session must not inherit a stale token
/// into the create it is performing. [`INSTANCE_ID_ENV`] is withheld for the
/// same reason — every create states its own identity.
const NEVER_FORWARDED_ENV: [&str; 7] = [
    "TERM",
    "LANG",
    "LC_ALL",
    "TMUX",
    "TMUX_TMPDIR",
    CREATE_TOKEN_ENV,
    INSTANCE_ID_ENV,
];

/// Whether an inherited env var is withheld from a new session — either
/// forced/stripped by policy, or superseded by a caller-supplied value.
fn skip_env(key: &str, caller_keys: &[&str]) -> bool {
    NEVER_FORWARDED_ENV.contains(&key) || caller_keys.contains(&key)
}

/// How far one create attempt got, shared between the create future and the
/// outer deadline that may drop it (#2812).
#[derive(Clone, Debug, PartialEq, Eq)]
enum CreateStage {
    /// No tmux mutation was requested yet, so a cancellation created nothing.
    Preparing,
    /// `new-session` is in flight; tmux may or may not have created a Session
    /// by the time the future is dropped. Only the ownership token can decide.
    Requested,
    /// `new-session` returned Ok: this attempt owns the Session with this name.
    Created,
    /// Every post-create step finished. This is the caller's result.
    Completed(SessionCreateOutcome),
}

type CreateProgress = Arc<Mutex<CreateStage>>;

fn set_create_stage(progress: &CreateProgress, stage: CreateStage) {
    if let Ok(mut slot) = progress.lock() {
        *slot = stage;
    }
}

fn create_stage(progress: &CreateProgress) -> CreateStage {
    progress
        .lock()
        .map(|slot| slot.clone())
        .unwrap_or(CreateStage::Preparing)
}

/// The socket and Session name that identify one create's exclusive claim.
type CreationKey = (PathBuf, String);
/// The process-wide claim table, so a create holds its claim across awaits.
type CreationRegistry = Mutex<HashMap<CreationKey, Arc<tokio::sync::Mutex<()>>>>;

/// One create's exclusive claim on a Session name for one tmux socket.
///
/// The claim covers the pre-create presence check, the create itself, and any
/// compensating cleanup. Without it two creates of one name could both observe
/// "absent" and the loser's cleanup could remove the winner's Session.
struct CreationPermit {
    key: CreationKey,
    slot: Arc<tokio::sync::Mutex<()>>,
}

fn creation_registry() -> &'static CreationRegistry {
    static REGISTRY: OnceLock<CreationRegistry> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn creation_permit(socket: &Path, name: &str) -> CreationPermit {
    let key = (socket.to_path_buf(), name.to_string());
    let mut registry = creation_registry()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let slot = registry
        .entry(key.clone())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone();
    CreationPermit { key, slot }
}

impl Drop for CreationPermit {
    fn drop(&mut self) {
        let mut registry = creation_registry()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // The registry and this permit hold the only strong references when no
        // other create for the name is waiting (a waiter would have cloned the
        // `Arc` before it could block on the lock). Removing under the registry
        // lock means a new caller either sees this mutex or creates the next
        // one after every existing holder has released it.
        if Arc::strong_count(&self.slot) <= 2 {
            registry.remove(&self.key);
        }
    }
}

// Re-exported from the Protocol Kernel (#678).
//
// This was declared here, and it is serialised straight onto the wire by
// `session.list` — so the agent's tmux model *was* the wire contract, and the
// kernel could not see it. It lives in `contracts/session/v1.rs` now, unchanged
// field for field; a second struct with the same fields would have been two
// definitions of one contract kept in step by nothing.
pub use nession_protocol::contracts::session::v1::SessionInfo;

/// The binding a Session is created with (#170 Phase A).
///
/// Creation is the one time all three layers start together: the effective
/// environment reaches the initial process through `new-session -e`, the same
/// overlay is installed on the Session for future panes, and the shell adapter
/// gets its runtime files. The Server and P2P create paths both go through
/// [`SessionManager::create_session_with_binding`], so they cannot drift.
pub struct SessionBindingInput<'a> {
    pub revision: u64,
    pub profiles: &'a [SessionEnvProfile],
    pub snapshots: &'a [EnvSnapshot],
}

/// Manages the lifecycle of tmux sessions (create / list / kill).
///
/// Holds the [`EnvManager`] that owns Session Environment Bindings, so killing
/// a Session can remove its durable binding state and a create can materialize
/// one before the initial shell starts.
pub struct SessionManager {
    env: EnvManager,
    /// tmux binary and socket. Every command this manager spawns is built here,
    /// so all of them address nession's own tmux server — see [`crate::tmux::cmd`].
    cmd: TmuxCmd,
    list_timeout: Duration,
    kill_timeout: Duration,
    create_timeout: Duration,
    /// Memory threshold percentage (0-100) for rejecting new sessions.
    /// `None` means use the default (90%). See [`crate::memory::check_memory_pressure`].
    memory_threshold_percent: Option<u8>,
    /// The Agent's Sandbox runtime. `None` refuses an explicit policy rather
    /// than silently executing it as Native.
    sandbox: Option<Arc<crate::sandbox_runtime::SandboxRuntime>>,
    /// The Agent's managed Workspace registry (#3407). `None` reports the
    /// inventory API unavailable; Native Sessions are unaffected.
    workspaces: Option<Arc<crate::workspace_manager::WorkspaceManager>>,
    /// The central Server's configured WebSocket URL (#3062). Managed
    /// creation derives its authorized blob HTTP base from this value; the
    /// Server never guesses its own public hostname.
    server_url: String,
    /// The Server Token used as the Bearer credential for authorized image
    /// blob reads (#3440). Empty on a standalone Agent, where there is no
    /// Server to fetch from.
    server_auth_token: nession_common::SecretString,
}

/// The result of one Session create.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionCreateOutcome {
    /// Non-fatal Environment Binding warnings.
    pub warnings: Vec<String>,
    /// What the Sandbox backend verified, for a sandboxed create.
    pub sandbox: Option<SandboxExecutionReport>,
}

impl SessionManager {
    /// Create a `SessionManager` whose env binding state defaults to a
    /// process-local temporary directory unique to this manager. Production
    /// replaces it with the Agent's durable directory through
    /// [`Self::with_env_state_dir`]; tests get isolation without sharing one
    /// directory across unrelated cases in the same process.
    pub fn new() -> Self {
        static NEXT_STATE_DIR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let id = NEXT_STATE_DIR.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Self {
            env: EnvManager::new(
                std::env::temp_dir()
                    .join(format!("nession-env-bindings-{}-{id}", std::process::id())),
            ),
            cmd: cmd::global().clone(),
            list_timeout: TMUX_LIST_TIMEOUT,
            kill_timeout: TMUX_KILL_TIMEOUT,
            create_timeout: TMUX_CREATE_TIMEOUT,
            memory_threshold_percent: None,
            sandbox: None,
            workspaces: None,
            server_url: String::new(),
            server_auth_token: nession_common::SecretString::new(String::new()),
        }
    }

    /// Create a `SessionManager` with a custom base directory for env binding
    /// state. Used by tests to keep one run's state out of another's.
    pub fn with_script_dir(script_dir: PathBuf) -> Self {
        Self {
            env: EnvManager::new(script_dir),
            ..Self::new()
        }
    }

    /// Put the durable Session Environment Binding state under `state_dir`.
    ///
    /// The runtime calls this with `~/.nession/agent/env-bindings`; the state
    /// has to outlive an Agent process, because tmux Sessions do.
    pub fn with_env_state_dir(mut self, state_dir: PathBuf) -> Self {
        self.env = self.env.with_state_dir(state_dir);
        self
    }

    /// Attach the Agent's Sandbox runtime and arm its execution reaper.
    ///
    /// Without a runtime, an explicit Sandbox policy is refused. Native
    /// sessions are unaffected.
    pub fn with_sandbox(mut self, sandbox: Arc<crate::sandbox_runtime::SandboxRuntime>) -> Self {
        sandbox.arm_reaper(self.tmux_dep());
        self.sandbox = Some(sandbox);
        self
    }

    /// Attach the Agent's durable managed Workspace registry (#3407).
    pub fn with_workspaces(
        mut self,
        workspaces: Arc<crate::workspace_manager::WorkspaceManager>,
    ) -> Self {
        self.workspaces = Some(workspaces);
        self
    }

    /// The managed Workspace registry this manager was composed with, when any.
    pub fn workspaces(&self) -> Option<&Arc<crate::workspace_manager::WorkspaceManager>> {
        self.workspaces.as_ref()
    }

    /// Record the central Server URL used to derive Managed download URLs.
    pub fn with_server_url(mut self, server_url: impl Into<String>) -> Self {
        self.server_url = server_url.into();
        self
    }

    /// The central Server URL this manager was composed with, when any.
    pub fn server_url(&self) -> &str {
        &self.server_url
    }

    /// Record the Server Token used for authorized image blob reads (#3440).
    pub fn with_server_auth_token(mut self, token: impl Into<String>) -> Self {
        self.server_auth_token = nession_common::SecretString::new(token);
        self
    }

    /// The Server Token for authorized image blob reads, when configured.
    pub fn server_auth_token(&self) -> &str {
        self.server_auth_token.as_str()
    }

    /// The Sandbox runtime this manager was composed with, when any.
    pub fn sandbox_runtime(&self) -> Option<&Arc<crate::sandbox_runtime::SandboxRuntime>> {
        self.sandbox.as_ref()
    }

    /// The tmux socket every command from this manager addresses.
    pub fn socket_path(&self) -> &std::path::Path {
        self.cmd.socket_path()
    }

    /// The tmux dependency this manager runs on, for the callers that are
    /// handed tmux addressing rather than reaching for the process-wide one —
    /// the attach backends ([`PtySession`](super::pty::PtySession),
    /// [`ControlModeSession`](super::control::ControlModeSession)).
    ///
    /// One manager's addressing, so a substituted binary reaches them too:
    /// without this the WebSocket layer would open an attach on the
    /// process-wide tmux while creating the session on the injected one.
    pub fn tmux_dep(&self) -> TmuxDep {
        TmuxDep::injected(self.cmd.clone())
    }

    /// The admin operations bound to this manager's addressing and budgets.
    fn sdk_ops(&self) -> TmuxOps {
        TmuxOps::new(self.cmd.as_sdk().clone()).with_timeouts(
            self.list_timeout,
            self.kill_timeout,
            self.create_timeout,
        )
    }

    /// Test seam: replace the whole tmux addressing (binary **and** socket).
    ///
    /// The substitution is *total* as of #991 step 6: it rebinds the manager's
    /// own addressing **and** the [`EnvManager`] it holds, whose operations used
    /// to reach the process-wide tmux behind this manager's back. A test that
    /// injects a fake and then drives `env().set_environment(…)` is driving the
    /// fake; before that, it was driving the real binary on the real socket and
    /// could not tell.
    #[cfg(test)]
    pub(crate) fn with_tmux_cmd(&mut self, cmd: TmuxCmd) -> &mut Self {
        self.cmd = cmd;
        self.env.with_tmux(TmuxDep::injected(self.cmd.clone()));
        self
    }

    /// Test seam: override the tmux binary (inject a fake `tmux`), keeping the
    /// socket unchanged. See [`with_tmux_cmd`](Self::with_tmux_cmd) for why the
    /// rebind must reach the [`EnvManager`] too — and prefer that seam when the
    /// test counts calls against a refusing fake: since #1225 a failed call
    /// heals + retries when the socket is verifiably dead, so the socket the
    /// retry decision reads must be one the test owns.
    #[cfg(test)]
    pub(crate) fn with_tmux_bin(&mut self, tmux_bin: impl Into<String>) -> &mut Self {
        let cmd = self.cmd.with_bin(tmux_bin);
        self.with_tmux_cmd(cmd)
    }

    /// Test seam: override per-command timeouts for fast, deterministic tests.
    #[cfg(test)]
    pub(crate) fn with_timeouts(
        &mut self,
        list: Duration,
        kill: Duration,
        create: Duration,
    ) -> &mut Self {
        self.list_timeout = list;
        self.kill_timeout = kill;
        self.create_timeout = create;
        self
    }

    /// Set the memory threshold percentage for rejecting new sessions.
    ///
    /// When container memory usage exceeds this percentage of the cgroup limit,
    /// `create_session` refuses to create a new session and returns an error.
    /// Pass `None` to use the default (90%).
    ///
    /// This is a runtime configuration, not a test seam — it is called by the
    /// agent runtime after loading [`AgentConfig`](crate::config::AgentConfig).
    pub fn with_memory_threshold(&mut self, threshold: Option<u8>) -> &mut Self {
        self.memory_threshold_percent = threshold;
        self
    }

    /// Access the environment manager for set/source/unsource operations.
    pub fn env(&self) -> &EnvManager {
        &self.env
    }

    pub async fn list_sessions(&self) -> Result<Vec<SessionInfo>> {
        Ok(self
            .sdk_ops()
            .list_sessions()
            .await?
            .into_iter()
            .map(|session| SessionInfo {
                name: session.name,
                created_at: session.created_at,
                window_count: session.window_count,
                attached_clients: session.attached_clients,
                width: session.width,
                height: session.height,
                foreground_command: session.foreground_command,
                working_dir: session.working_dir,
                instance_id: session.instance_id,
            })
            .collect())
    }

    /// The Nession-owned instance identity for a tmux Session (#2789, #2974).
    ///
    /// Stored as the `@nession_instance_id` tmux user option, so it outlives an
    /// Agent restart (the tmux server owns the Session) and dies with the
    /// Session: killing and recreating the same name starts without the option,
    /// so the new instance gets a fresh id and cannot inherit metadata or a
    /// Claude binding. A legacy Session initializes one on first access; an
    /// invalid stored value is replaced rather than becoming a path component.
    ///
    /// When the option is absent — a legacy Session, or a Session whose durable
    /// identity was removed after creation — the identity is seeded from
    /// [`INSTANCE_ID_ENV`] if the Session carries it. A create delivers its id
    /// there by the same `new-session` that creates the Session and builds the
    /// Claude binding path from it, so adopting that value cannot race the
    /// create into a second identity (which would point the reader at a file no
    /// hook was told to write).
    pub async fn session_instance_id(&self, session_name: &str) -> Result<String> {
        let ops = self.sdk_ops();
        if let Some(stored) = ops.show_option(session_name, INSTANCE_ID_OPTION).await? {
            if let Ok(id) = uuid::Uuid::parse_str(stored.trim()) {
                return Ok(id.to_string());
            }
        }

        let delivered = ops
            .show_environment(session_name, INSTANCE_ID_ENV)
            .await
            .with_context(|| format!("read the instance identity of session {session_name}"))?;
        let fresh = delivered
            .as_deref()
            .and_then(|value| uuid::Uuid::parse_str(value.trim()).ok())
            .unwrap_or_else(uuid::Uuid::new_v4);
        ops.set_option(session_name, INSTANCE_ID_OPTION, &fresh.to_string())
            .await?;
        // Two callers may race the first initialization. The winner's value is
        // what tmux now holds, and it is the one this Session's metadata must
        // use even if this caller's UUID lost.
        let stored = ops
            .show_option(session_name, INSTANCE_ID_OPTION)
            .await?
            .ok_or_else(|| anyhow::anyhow!("instance id was not stored for {session_name}"))?;
        uuid::Uuid::parse_str(stored.trim())
            .map(|id| id.to_string())
            .with_context(|| format!("invalid instance id stored for {session_name}"))
    }

    /// Query the current working directory of a tmux session's active pane.
    pub async fn get_session_cwd(&self, session_name: &str) -> Result<String> {
        self.display_message(session_name, "#{pane_current_path}")
            .await
    }

    /// The command running in a tmux session's active pane.
    ///
    /// This is what tells the Claude Code capability whether Claude is running
    /// **now** (#1005 criterion 4). It is the same signal the Web projection
    /// already uses to decide the capability is `active`, which is deliberate:
    /// one source means the terminal's presence and the conversation's
    /// freshness cannot disagree about whether Claude is running.
    pub async fn get_session_command(&self, session_name: &str) -> Result<String> {
        self.display_message(session_name, "#{pane_current_command}")
            .await
    }

    /// One variable from a tmux session's environment.
    ///
    /// `Ok(None)` is "the session holds no such variable"; an error is "the
    /// question could not be asked". The Claude Code memory resolver needs that
    /// distinction to avoid reading its defaults when the Session's overrides
    /// exist but are unobservable (#2689).
    ///
    /// Like every other tmux query here, this goes through the manager's own
    /// `sdk_ops`, so it addresses the socket this manager was built for.
    pub async fn get_session_env(&self, session_name: &str, name: &str) -> Result<Option<String>> {
        self.sdk_ops().show_environment(session_name, name).await
    }

    async fn display_message(&self, session_name: &str, format: &str) -> Result<String> {
        self.sdk_ops().display_message(session_name, format).await
    }

    /// Create a new detached tmux session at `width` × `height`.
    ///
    /// `width` is the release-selected fixed column count (#2487): the caller
    /// arrives with the Server's value (relayed create) or this Agent's
    /// configuration (a direct/standalone caller). It is validated rather than
    /// clamped, so a bad caller is told instead of silently given a different
    /// grid. `height` is the initial pane height; the first client to attach
    /// replaces it with its measured rows.
    ///
    /// There is deliberately **no per-client viewport**: the session has one
    /// window and one pane, and a row resize by the controller moves it for
    /// all of them. Width, once chosen here or by the pane that already
    /// exists, is the Session's authority and is enforced on resize.
    ///
    /// `window-size` is left at tmux's default (`latest`) so that clients can
    /// resize the window at all; locking it would freeze the pane at the
    /// create-time size. `window_size_lock_tests` below asserts that it stays
    /// unset.
    /// Validate a client-requested initial cwd before tmux starts.
    pub fn validate_initial_working_dir(path: &str) -> Result<String> {
        let trimmed = path.trim();
        if trimmed.is_empty() {
            anyhow::bail!("working_dir is empty");
        }
        let p = std::path::Path::new(trimmed);
        if !p.is_absolute() {
            anyhow::bail!("working_dir must be absolute");
        }
        if !p.exists() {
            anyhow::bail!("working_dir does not exist");
        }
        if !p.is_dir() {
            anyhow::bail!("working_dir is not a directory");
        }
        Ok(trimmed.to_string())
    }

    /// Create a Session with a flat environment and no Environment Binding.
    ///
    /// Kept for callers that only need a tmux Session (tests, internal
    /// helpers). Every production create goes through
    /// [`Self::create_session_with_binding`], which is the path that owns all
    /// three binding layers.
    ///
    /// ## Failure and retry contract (#2812)
    ///
    /// Once `tmux new-session` has created the Session, a failure or timeout in
    /// any later step removes that Session and any partially written binding
    /// state before the error is returned. Retrying the same name therefore
    /// means "create it", never "it already exists" because of an abandoned
    /// attempt. A Session that existed **before** this call is never the
    /// create's to remove: the create refuses the duplicate deterministically
    /// and touches nothing.
    ///
    /// Creates of one name on one socket are serialized, so concurrent callers
    /// cannot both observe "absent" and race one cleanup against the other's
    /// Session. When the deadline drops the create while `new-session` is in
    /// flight, the outcome is ambiguous; the per-create ownership token decides
    /// whether the Session that appears is this attempt's. If ownership cannot
    /// be proven, the Session is left untouched and the returned error says so.
    pub async fn create_session(
        &self,
        name: &str,
        width: u16,
        height: u16,
        working_dir: &str,
        env: &[(String, String)],
    ) -> Result<()> {
        self.create_session_inner(name, width, height, working_dir, env, None, None, None)
            .await
            .map(|_| ())
    }

    /// Create a Session whose initial process, future panes, and shell adapter
    /// all receive one Environment Binding (#170, Layer A).
    ///
    /// Returns the non-fatal warnings produced by resolving the overlay
    /// (reserved-key collisions, for example). The binding is recorded in the
    /// Agent's durable state before this returns, so a later Agent restart can
    /// still restore base values when the binding changes.
    ///
    /// The failure/retry contract is [`Self::create_session`]'s: a post-create
    /// failure removes the Session *and* the binding state the attempt wrote,
    /// so a retry starts from the same empty state as a first create.
    pub async fn create_session_with_binding(
        &self,
        name: &str,
        width: u16,
        height: u16,
        working_dir: &str,
        binding: SessionBindingInput<'_>,
    ) -> Result<SessionCreateOutcome> {
        self.create_session_inner(
            name,
            width,
            height,
            working_dir,
            &[],
            Some(binding),
            None,
            None,
        )
        .await
    }

    /// Create a Session with an optional Environment Binding and an optional
    /// Sandbox policy (#2681).
    ///
    /// The policy is compiled and prepared before `new-session`, and the
    /// create fails closed when the host cannot install a requested guarantee.
    /// A successful create returns the mechanisms the Agent verified.
    pub async fn create_session_with_options(
        &self,
        name: &str,
        width: u16,
        height: u16,
        working_dir: &str,
        binding: Option<SessionBindingInput<'_>>,
        sandbox: Option<&SandboxPolicy>,
    ) -> Result<SessionCreateOutcome> {
        self.create_session_inner(
            name,
            width,
            height,
            working_dir,
            &[],
            binding,
            sandbox,
            None,
        )
        .await
    }

    /// Create a Session whose initial Pane runs inside a prepared EROFS
    /// composition (#3062).
    ///
    /// `tmux_working_dir` is the Agent-owned host directory tmux starts the
    /// Session in; `sandbox_working_dir` is the composed path (`/workspace`)
    /// the launcher enters inside the sandbox. The policy is compiled and
    /// prepared before `new-session`, and a host that cannot install it
    /// refuses the create with no Native fallback.
    #[allow(clippy::too_many_arguments)]
    pub async fn create_session_managed(
        &self,
        name: &str,
        width: u16,
        height: u16,
        tmux_working_dir: &str,
        sandbox_working_dir: &str,
        binding: Option<SessionBindingInput<'_>>,
        sandbox: &SandboxPolicy,
    ) -> Result<SessionCreateOutcome> {
        self.create_session_inner(
            name,
            width,
            height,
            tmux_working_dir,
            &[],
            binding,
            Some(sandbox),
            Some(sandbox_working_dir),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn create_session_inner(
        &self,
        name: &str,
        width: u16,
        height: u16,
        working_dir: &str,
        env: &[(String, String)],
        binding: Option<SessionBindingInput<'_>>,
        sandbox: Option<&SandboxPolicy>,
        sandbox_working_dir: Option<&str>,
    ) -> Result<SessionCreateOutcome> {
        // Check memory pressure before creating a new session. This prevents
        // container-level OOM by refusing new sessions when memory usage is too
        // high, rather than letting the entire container die.
        crate::memory::check_memory_pressure(self.memory_threshold_percent)?;

        // Serialize every create of this name on this socket. The critical
        // section covers the presence check, the tmux create, and any
        // compensating cleanup: without it two creates could both observe
        // "absent" and the loser's cleanup could remove the winner's Session
        // (#2812). The claim is per name and socket, so unrelated creates stay
        // parallel.
        let permit = creation_permit(self.socket_path(), name);
        let slot = permit.slot.clone();
        let _serialized = slot.lock().await;

        // Delivered by the same `new-session` that creates the Session. If the
        // deadline drops this future while `new-session` is in flight, the
        // reconciler uses it to prove whether the Session that appeared is
        // this attempt's.
        let token = uuid::Uuid::new_v4().to_string();
        let progress: CreateProgress = Arc::new(Mutex::new(CreateStage::Preparing));

        // The presence check is inside the budget as well. A same-named
        // Session that exists before this attempt is never this attempt's to
        // remove; `new-session` refuses the duplicate anyway, but only a check
        // taken under the guard lets a later deadline tell "the Session I
        // made" from "the Session that was already here". A failed question is
        // an error: proceeding would create a Session whose ownership a
        // timeout could not establish. tmux bounds the query itself, and the
        // create deadline bounds the whole attempt — a server that cannot
        // answer must not hold the per-name claim past the budget.
        let attempt = async {
            let sessions = self
                .sdk_ops()
                .list_sessions()
                .await
                .with_context(|| format!("check whether session {name} already exists"))?;
            if sessions.iter().any(|session| session.name == name) {
                anyhow::bail!("session {name} already exists; refusing to replace it");
            }
            self.create_session_impl(
                name,
                width,
                height,
                working_dir,
                env,
                binding,
                sandbox,
                sandbox_working_dir.unwrap_or(working_dir),
                &token,
                &progress,
            )
            .await
        };

        match tokio::time::timeout(self.create_timeout, attempt).await {
            Ok(outcome) => outcome,
            Err(_) => {
                // The inner future was dropped at the deadline; `progress` is
                // the only record of how far it got. `Completed` means it
                // actually finished in the same tick — still a success.
                if let CreateStage::Completed(outcome) = create_stage(&progress) {
                    return Ok(outcome);
                }
                let note = match tokio::time::timeout(
                    TMUX_CREATE_RECONCILE_TIMEOUT,
                    self.reconcile_create_after_deadline(name, &token, &progress),
                )
                .await
                {
                    Ok(note) => note,
                    Err(_) => {
                        "; the interrupted create could not be reconciled in time".to_string()
                    }
                };
                Err(anyhow::anyhow!(
                    "tmux create-session timed out after {:?}{note}",
                    self.create_timeout
                ))
            }
        }
    }

    /// The Nession policy half of create: which environment a session
    /// inherits, the post-create steps that make it the Session that was
    /// asked for, and the compensation that keeps a failure truthful.
    ///
    /// The argv and the three-stage delivery are the SDK's
    /// [`TmuxOps::new_session`]. Everything after it runs while this attempt's
    /// ownership of the Session is known (see [`Self::create_session_inner`]).
    #[allow(clippy::too_many_arguments)]
    async fn create_session_impl(
        &self,
        name: &str,
        width: u16,
        height: u16,
        working_dir: &str,
        env: &[(String, String)],
        binding: Option<SessionBindingInput<'_>>,
        sandbox: Option<&SandboxPolicy>,
        sandbox_working_dir: &str,
        token: &str,
        progress: &CreateProgress,
    ) -> Result<SessionCreateOutcome> {
        nession_common::config::validate_terminal_cols(width).map_err(anyhow::Error::msg)?;
        // History depth needs nothing here: it travels as `-f` on every tmux
        // invocation this manager makes (`cmd.rs`), so whichever one starts the
        // server installs it before the window below exists.
        //
        // Pass through the agent process environment (PATH, NODE_PATH, etc.) so
        // tools installed via an init container are available in sessions.
        // Caller-supplied keys are withheld from the inherited copy and applied
        // afterwards, so a profile's value is the one the process sees.
        let mut warnings = Vec::new();
        let overlay = match &binding {
            Some(binding) => {
                let overlay = EnvManager::merge_snapshots(binding.snapshots)?;
                warnings.extend(overlay.warnings.clone());
                overlay
            }
            None => EffectiveOverlay {
                vars: env.to_vec(),
                warnings: Vec::new(),
            },
        };

        // A Session with a binding gets a Session-local shell adapter. The
        // adapter is installed before the shell starts, because a zsh adapter
        // is selected by ZDOTDIR and a bash adapter by the launch command.
        let adapter = match &binding {
            Some(_) => {
                let tmux_default = self.tmux_dep().ops().default_shell().await.ok().flatten();
                let shell = resolve_session_shell(
                    tmux_default,
                    std::env::var("SHELL").ok(),
                    passwd_login_shell(),
                );
                self.env.install_shell_adapter(name, shell.as_deref()).await
            }
            None => ShellAdapter::unsupported(None, "no Environment Binding"),
        };

        let mut caller_keys: Vec<&str> = overlay.vars.iter().map(|(k, _)| k.as_str()).collect();
        caller_keys.extend(adapter.env.iter().map(|(k, _)| k.as_str()));
        let has_ps1 = overlay.vars.iter().any(|(key, _)| key == "PS1");
        // This tmux Session instance's identity (#2974), fixed before the
        // `new-session` that creates it. The same value goes into the Session's
        // environment, the Claude binding path, and — recorded at the end of
        // the post-create phase — the durable `@nession_instance_id` option, so
        // the hook, the reader and an Agent restart cannot disagree. Nothing
        // derived from the name can fence a delete/recreate; this can.
        let instance_id = uuid::Uuid::new_v4().to_string();
        let claude_env = claude_binding_env(name, &instance_id);

        // Force TERM and locale first so TUI apps render correctly. Containers
        // default to C/POSIX (no Unicode) and an unset or "dumb" TERM.
        let mut session_env: Vec<(String, String)> = vec![
            ("TERM".to_string(), "xterm-256color".to_string()),
            ("LANG".to_string(), "C.UTF-8".to_string()),
        ];
        session_env
            .extend(std::env::vars().filter(|(key, _)| !skip_env(key, caller_keys.as_slice())));
        session_env.extend(overlay.vars.iter().cloned());
        if !has_ps1 {
            session_env.push(("NESSON_PS1".to_string(), DEFAULT_PS1.to_string()));
            session_env.push((
                "PROMPT_COMMAND".to_string(),
                r#"[ -n "$NESSON_PS1" ] && { PS1="$NESSON_PS1"; unset NESSON_PS1; }"#.to_string(),
            ));
        }
        session_env.extend(claude_env);
        // The instance identity the binding path was built from. This is what
        // lets a reader of the same tmux Session (including one in a restarted
        // Agent) derive that path without the name, and what marks the Session
        // as fenced at all (#2974).
        session_env.push((INSTANCE_ID_ENV.to_string(), instance_id.clone()));
        // This create's ownership fence, delivered by the `new-session` below.
        // Profiles cannot set it: `NESSON_*` keys are reserved.
        session_env.push((CREATE_TOKEN_ENV.to_string(), token.to_string()));
        // Last, so the adapter's ZDOTDIR cannot be overwritten by the agent's
        // inherited environment.
        session_env.extend(adapter.env.iter().cloned());

        // Prepare the Sandbox before `new-session` starts a process. The
        // policy is the request; the runtime owns host-local facts. An
        // explicit policy without a configured runtime is refused rather than
        // silently executed as a Native Session.
        let mut sandbox_prepared = match sandbox {
            Some(policy) => {
                // Validate even an explicitly disabled policy: a payload that
                // says `enabled: false` while carrying constraints is
                // contradictory and must not be silently ignored.
                nession_sandbox::compile(policy).map_err(|error| anyhow::anyhow!("{error}"))?;
                if !policy.enabled {
                    None
                } else {
                    let Some(runtime) = self.sandbox.clone() else {
                        anyhow::bail!(
                        "this Agent has no Sandbox backend configured; refusing the Session's Sandbox policy"
                    );
                    };
                    let inner_command = if adapter.command.is_empty() {
                        let tmux_default = self.sdk_ops().default_shell().await.ok().flatten();
                        let shell = resolve_session_shell(
                            tmux_default,
                            std::env::var("SHELL").ok(),
                            passwd_login_shell(),
                        )
                        .ok_or_else(|| {
                            anyhow::anyhow!(
                                "could not resolve a shell to run inside the sandboxed Session"
                            )
                        })?;
                        vec![shell, "-l".to_string()]
                    } else {
                        adapter.command.clone()
                    };
                    let request = nession_sandbox::LaunchRequest {
                        policy: policy.clone(),
                        session_name: name.to_string(),
                        instance_id: instance_id.clone(),
                        working_dir: sandbox_working_dir.to_string(),
                        inner_command,
                        tmux_socket: Some(self.socket_path().to_path_buf()),
                    };
                    let prepared = tokio::task::spawn_blocking(move || runtime.prepare(&request))
                        .await
                        .context("sandbox preparation task")?
                        .map_err(|error| anyhow::anyhow!("{error}"))?;
                    Some(prepared)
                }
            }
            None => None,
        };
        if let Some(prepared) = &sandbox_prepared {
            session_env.extend(prepared.env().iter().cloned());
        }
        let launch_command = sandbox_prepared
            .as_ref()
            .map(|prepared| prepared.command().to_vec())
            .unwrap_or_else(|| adapter.command.clone());

        // The creation fact is recorded as soon as `new-session` returns Ok:
        // from there on, a post-create failure or a cancelled future knows the
        // Session is this attempt's.
        set_create_stage(progress, CreateStage::Requested);
        let outcome = match self
            .sdk_ops()
            .new_session(&nession_tmux::ops::NewSession {
                name: name.to_string(),
                working_dir: working_dir.to_string(),
                width,
                height,
                env: session_env,
                command: launch_command,
            })
            .await
        {
            Ok(outcome) => {
                set_create_stage(progress, CreateStage::Created);
                outcome
            }
            Err(error) => {
                // A failed `new-session` is not proof that nothing was created:
                // the legacy fallback creates the Session and then types the
                // environment, and that second stage can fail. Reconcile only a
                // Session this attempt can prove is its own, then report the
                // original failure — plus, when a Session was left behind that
                // this attempt cannot prove it made, the fact that it is there.
                if let Some(prepared) = sandbox_prepared.take() {
                    // No Session exists to verify; release the owned channel,
                    // cgroup and record now instead of waiting for the reaper.
                    if let Err(abort) = prepared.abort() {
                        tracing::warn!("could not release the unused sandbox: {abort}");
                    }
                }
                let note = self.reconcile_ambiguous_create(name, token).await;
                return if note.is_empty() {
                    Err(error)
                } else {
                    Err(anyhow::anyhow!("{error:#}{note}"))
                };
            }
        };

        // Post-create steps run in their own bounded phase, while ownership is
        // known. A required step's failure or this phase's deadline removes the
        // Session before the error is returned, so a retry of the same name is
        // not refused by a Session nobody is tracking.
        let sandbox_runtime = self.sandbox.clone();
        let post_create = async move {
            // Deliver the instance identity to the Session's environment as a
            // required part of the create (#2974). `new-session -e` already
            // carries it and `propagate_env_best_effort` replays it, but where
            // the replay cannot reach the Session environment a marker-less
            // Session is indistinguishable from a pre-fence one — and the
            // Claude reader would then consult the name-derived file a deleted
            // Session may have left. A Session whose binding fence cannot be
            // established is not the Session that was asked for, so this is
            // Required: the compensation below removes it and the retry starts
            // clean.
            self.sdk_ops()
                .set_environment(name, INSTANCE_ID_ENV, &instance_id)
                .await
                .with_context(|| {
                    format!("record the instance identity of session {name} in its environment")
                })?;
            // The requested size is the Session's width, not whatever client
            // tmux considers "latest" on a shared server. On tmux 3.4 with the
            // default `window-size latest`, a client attached to another
            // Session sized a newly created Session to its own 80x24 and
            // discarded `-x 96 -y 24` (#2520). `new-session`'s flags alone are
            // therefore not the create's size: apply the requested geometry
            // explicitly and let a failure fail the create, because a Session
            // at the wrong width is not the Session that was asked for.
            self.apply_session_size(name, width, height)
                .await
                .with_context(|| format!("apply the requested size for session {name}"))?;
            // tmux's `resize-window` pins `window-size` to `manual` as a side
            // effect. Restore the dynamic policy: the controller's authorized
            // resize path still drives rows through the attached client, and
            // only an explicit `resize-window` (this correction) should be
            // manual.
            //
            // BestEffort, like the other session options: a refused option
            // leaves the Session at the size this create just applied (manual),
            // which degrades later row resizes rather than the created width.
            // Observable rather than dropped.
            if let Err(e) = self
                .sdk_ops()
                .set_option(name, "window-size", "latest")
                .await
            {
                tracing::warn!(
                    "best-effort dynamic `window-size` restore for session {name} failed: {e:#}"
                );
            }

            if !outcome.used_e {
                // BestEffort cosmetic cleanup: hides the `export …` line the
                // fallback typed from the pane's scrollback. The environment
                // was delivered by that statement, so a scrollback that could
                // not be cleared is still a session that has it.
                crate::tmux::env::clear_history(&self.tmux_dep(), name).await;
            }

            // Enable tmux mouse mode so mouse events reach tmux as SGR
            // sequences (copy-mode scroll, pane selection, and forwarding to
            // TUI apps). The web client lets xterm.js use its default
            // behaviour.
            //
            // **BestEffort**: a failure degrades *interaction* (no mouse-driven
            // copy-mode, no pane selection) but not the session. The option is
            // not consulted on the input path, it holds no session state, and
            // the web client carries its own scrollback. Observable rather than
            // dropped: the failure is WARNed with tmux's reason.
            if let Err(e) = self.sdk_ops().set_option(name, "mouse", "on").await {
                tracing::warn!(
                    "best-effort `set-option mouse on` for session {name} failed: {e:#}"
                );
            }

            if let Some(binding) = binding {
                // Baseline = what the Session would have had without the
                // binding. Read from the Agent process environment *before*
                // caller keys were withheld, so `MODE=default` can be restored
                // later instead of being unset.
                let inherited: HashMap<String, String> = std::env::vars()
                    .filter(|(key, _)| !NEVER_FORWARDED_ENV.contains(&key.as_str()))
                    .collect();
                let baseline: BTreeMap<String, Option<String>> = overlay
                    .vars
                    .iter()
                    .map(|(key, _)| (key.clone(), inherited.get(key).cloned()))
                    .collect();
                self.env
                    .record_created_binding(
                        name,
                        binding.revision,
                        binding.profiles,
                        &overlay,
                        baseline,
                        &adapter,
                    )
                    .await
                    .with_context(|| {
                        format!("record the Environment Binding for session {name}")
                    })?;
            }

            // Last, record the durable owner of the identity (#2789, #2974).
            // The value is the same one the environment marker and the hook's
            // binding path carry, so the reader derives the path the hook was
            // handed. Writing it at the end — and Required, like the marker —
            // means a first-time lazy initialization (`session_instance_id`)
            // that read this name before the Session was deleted can only
            // clobber it by executing its name-addressed `set-option` after
            // the whole create; the residual window is a stalled process, and
            // a lost id there fails toward "no binding", never toward another
            // Session's conversation.
            self.sdk_ops()
                .set_option(name, INSTANCE_ID_OPTION, &instance_id)
                .await
                .with_context(|| format!("record the tmux instance identity of session {name}"))?;

            // The sandboxed Pane is verified only after every other required
            // create step: the bridge is still waiting on the launch barrier,
            // so no user code has run. Verification releases it on success;
            // on failure the caller's compensation kills the Session and the
            // prepared resources are removed.
            let mut sandbox_report = None;
            if let Some(prepared) = sandbox_prepared {
                let Some(runtime) = sandbox_runtime else {
                    anyhow::bail!("the Sandbox runtime disappeared between prepare and verify");
                };
                let panes = self
                    .sdk_ops()
                    .list_panes()
                    .await
                    .context("locate the sandboxed Pane")?;
                let pane = panes
                    .iter()
                    .find(|pane| {
                        pane.session_name == name && pane.window_index == 0 && pane.pane_index == 0
                    })
                    .ok_or_else(|| {
                        anyhow::anyhow!("the sandboxed Session has no Pane to verify")
                    })?;
                let pane_pid = pane.pane_pid.ok_or_else(|| {
                    anyhow::anyhow!("the sandboxed Session has no Pane process to verify")
                })?;
                let target = crate::sandbox_runtime::PaneLaunchTarget {
                    pane_pid,
                    pane_id: Some(pane.pane_id.clone()),
                    window_id: Some(pane.window_id.clone()),
                };
                let session_name = name.to_string();
                let report = tokio::task::spawn_blocking(move || {
                    crate::sandbox_runtime::launch_and_verify(
                        &runtime,
                        prepared,
                        target,
                        &session_name,
                        None,
                    )
                })
                .await
                .context("sandbox verification task")??;
                sandbox_report = Some(report);
            }

            Ok::<SessionCreateOutcome, anyhow::Error>(SessionCreateOutcome {
                warnings,
                sandbox: sandbox_report,
            })
        };

        match tokio::time::timeout(self.create_timeout, post_create).await {
            Ok(Ok(outcome)) => {
                // Record completion before returning so a deadline firing in
                // the same tick reads success, not a stale in-progress stage.
                set_create_stage(progress, CreateStage::Completed(outcome.clone()));
                Ok(outcome)
            }
            Ok(Err(error)) => {
                self.compensate_created_session(name).await;
                Err(error)
            }
            Err(_) => {
                self.compensate_created_session(name).await;
                Err(anyhow::anyhow!(
                    "tmux create-session timed out after {:?} while finishing session {name}",
                    self.create_timeout
                ))
            }
        }
    }

    /// Reconcile a create whose outer deadline fired.
    ///
    /// `Created` is proof enough to remove the Session: `new-session` returned
    /// Ok under the per-name guard, and the pre-create check proved no Session
    /// of that name existed. `Requested` is ambiguous — the future was dropped
    /// while `new-session` was in flight — so only a Session carrying this
    /// attempt's token is removed.
    async fn reconcile_create_after_deadline(
        &self,
        name: &str,
        token: &str,
        progress: &CreateProgress,
    ) -> String {
        match create_stage(progress) {
            // The caller returns this stage as success; reachable only for
            // exhaustiveness.
            CreateStage::Completed(_) => String::new(),
            CreateStage::Created => {
                self.compensate_created_session(name).await;
                "; the Session created by this attempt was removed".to_string()
            }
            CreateStage::Requested => self.reconcile_ambiguous_create(name, token).await,
            CreateStage::Preparing => String::new(),
        }
    }

    /// Reconcile a create whose tmux outcome this attempt cannot yet prove.
    ///
    /// Under the per-name guard and the pre-create absence check, a Session
    /// that exists now was either made by this attempt or appeared on the
    /// socket outside Nession (a shared socket, a manual `tmux new`). Only the
    /// creation token distinguishes them. A Session that cannot be proven is
    /// left untouched and the returned note says so: killing it would destroy
    /// someone else's Session.
    async fn reconcile_ambiguous_create(&self, name: &str, token: &str) -> String {
        let sessions = match self.sdk_ops().list_sessions().await {
            Ok(sessions) => sessions,
            Err(error) => {
                tracing::warn!(
                    "could not inspect session {name} after an interrupted create: {error:#}"
                );
                return format!("; the state of session {name} could not be reconciled");
            }
        };
        if !sessions.iter().any(|session| session.name == name) {
            return String::new();
        }
        match self
            .sdk_ops()
            .show_environment(name, CREATE_TOKEN_ENV)
            .await
        {
            Ok(Some(value)) if value == token => {
                self.compensate_created_session(name).await;
                "; the Session created by this attempt was removed".to_string()
            }
            Ok(_) => {
                tracing::warn!(
                    "session {name} exists after an interrupted create but does not carry \
                     this attempt's {CREATE_TOKEN_ENV}; leaving it untouched"
                );
                format!(
                    "; a Session named {name} could not be proven to belong to this \
                     create, so it was left untouched"
                )
            }
            Err(error) => {
                tracing::warn!(
                    "could not prove ownership of session {name} after an interrupted \
                     create: {error:#}"
                );
                format!(
                    "; the ownership of the existing Session {name} could not be proven, \
                     so it was left untouched"
                )
            }
        }
    }

    /// Remove the Session this create made and any binding state it wrote.
    ///
    /// Only called once ownership is proven (`Created`, or a matching creation
    /// token). The kill is best-effort and observable: if it fails, a retry's
    /// duplicate refusal is the truthful state and the warning says the
    /// cleanup did not finish.
    async fn compensate_created_session(&self, name: &str) {
        match self.sdk_ops().kill_session(name).await {
            Ok(()) => tracing::warn!(
                "removed session {name} after its create failed, so the name is safe to retry"
            ),
            Err(error) => tracing::warn!(
                "could not remove session {name} after its create failed: {error:#}; \
                 a retry may report it as already existing"
            ),
        }
        // A binding record for a Session this create is removing would be
        // stale and could give a later same-named Session an inherited
        // baseline. Removal is idempotent.
        self.env.clear_session_binding(name).await;
        self.cleanup_sandbox_session(name).await;
    }

    /// Release a Session's Sandbox resources, if it has any.
    async fn cleanup_sandbox_session(&self, name: &str) {
        let Some(sandbox) = self.sandbox.clone() else {
            return;
        };
        let session_name = name.to_string();
        match tokio::task::spawn_blocking(move || sandbox.cleanup_session(&session_name)).await {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => tracing::warn!(
                "could not release the Sandbox resources of session {name}: {error:#}"
            ),
            Err(error) => {
                tracing::warn!("Sandbox cleanup task for session {name} failed: {error}")
            }
        }
    }

    /// Apply the Agent's resolved size to a Session's pane.
    pub(crate) async fn apply_session_size(&self, name: &str, cols: u16, rows: u16) -> Result<()> {
        self.sdk_ops().resize_window(name, cols, rows).await
    }

    pub async fn kill_session(&self, name: &str) -> Result<()> {
        self.sdk_ops().kill_session(name).await?;

        // The Session is gone; a binding record left behind would describe a
        // Session that no longer exists and could make a later same-named
        // Session inherit a stale baseline.
        self.env.clear_session_binding(name).await;

        // The Claude binding file is deliberately not removed. It is fenced by
        // this Session's instance id (#2974), so a later same-name Session
        // cannot read it; and a `SessionEnd` hook still finishing from this
        // instance may write it after the kill, so deleting it here would
        // mostly race that write rather than make anything safer.

        // A killed Session's execution domain is gone; release exactly the
        // resources this Agent owns for it.
        self.cleanup_sandbox_session(name).await;
        Ok(())
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod shell_resolution_tests {
    use super::*;

    #[test]
    fn tmux_default_wins_then_shell_then_passwd() {
        let tmux = Some("/bin/bash".to_string());
        let env = Some("/bin/zsh".to_string());
        let passwd = Some("/bin/sh".to_string());
        assert_eq!(
            resolve_session_shell(tmux, env.clone(), passwd.clone()).as_deref(),
            Some("/bin/bash"),
            "tmux's own default-shell is the first authority"
        );
        assert_eq!(
            resolve_session_shell(None, env, passwd.clone()).as_deref(),
            Some("/bin/zsh"),
            "the Agent's SHELL is the second authority"
        );
        assert_eq!(
            resolve_session_shell(None, None, passwd).as_deref(),
            Some("/bin/sh"),
            "the passwd login shell is the fallback"
        );
        assert_eq!(resolve_session_shell(None, None, None), None);
    }

    #[test]
    fn blank_values_are_not_answers() {
        assert_eq!(
            resolve_session_shell(
                Some("   ".to_string()),
                Some(String::new()),
                Some("/bin/bash".to_string()),
            )
            .as_deref(),
            Some("/bin/bash"),
            "an empty tmux answer must fall through, not win as an empty shell"
        );
        assert_eq!(
            resolve_session_shell(None, Some(" \t".to_string()), None),
            None
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_passwd_login_shell_is_read_for_this_user() {
        let shell = passwd_login_shell().expect("the test user has a login shell");
        assert!(shell.starts_with('/'), "{shell}");
    }

    /// The staging shape: no `SHELL`, no pre-existing tmux server. The passwd
    /// fallback must resolve to a shell this Agent can adapt.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_container_without_shell_env_still_installs_an_adapter() {
        let shell = resolve_session_shell(None, None, passwd_login_shell())
            .expect("the test user has a login shell");
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::new().with_env_state_dir(dir.path().join("state"));
        let adapter = mgr
            .env
            .install_shell_adapter("nession-shell-fallback", Some(&shell))
            .await;
        assert!(
            adapter.supported,
            "resolved shell {shell:?} has no adapter: {:?}",
            adapter.reason
        );
    }
}

#[cfg(test)]
mod binding_create_tests {
    use super::*;
    use crate::test_support::TestSession;
    use nession_protocol::contracts::env::v1::EnvSource;

    fn profile(name: &str) -> SessionEnvProfile {
        SessionEnvProfile {
            profile: nession_protocol::contracts::env::v1::EnvFileRef {
                name: name.to_string(),
                source: EnvSource::Server,
                agent_id: None,
            },
            phase: "create".to_string(),
            content_hash: None,
        }
    }

    /// The initial shell — not only tmux's future-pane environment — receives
    /// the binding (#170 Layer A).
    ///
    /// The test drives the shell with `send-keys` deliberately: that is the
    /// *test's* instrument for asking the process what it sees, never the
    /// Agent's mechanism for changing the binding. The implementation touched
    /// no terminal input to get here.
    #[tokio::test]
    async fn create_with_binding_applies_the_environment_to_the_initial_shell() {
        // Skip on machines without tmux; the Rust gates run where it exists.
        if cmd::global().tokio().arg("-V").status().await.is_err() {
            eprintln!("tmux not available, skipping");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mgr = SessionManager::new().with_env_state_dir(dir.path().join("state"));
        let session = TestSession::new("binding-create");
        let name = session.name();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let snapshots = vec![EnvSnapshot {
            name: "create.env".to_string(),
            source: EnvSource::Server,
            agent_id: None,
            vars: vec![("NS_CREATE_TEST".to_string(), "v".to_string())],
            warnings: Vec::new(),
        }];

        let outcome = mgr
            .create_session_with_binding(
                name,
                SESSION_WIDTH,
                SESSION_HEIGHT,
                &cwd,
                SessionBindingInput {
                    revision: 1,
                    profiles: &[profile("create.env")],
                    snapshots: &snapshots,
                },
            )
            .await
            .expect("the binding is materialized at creation");
        assert!(outcome.warnings.is_empty());

        // Layer B: tmux's Session environment, which future panes inherit.
        let layer_b = mgr
            .tmux_dep()
            .ops()
            .show_environment(name, "NS_CREATE_TEST")
            .await
            .expect("tmux answers the query");
        assert_eq!(layer_b.as_deref(), Some("v"));

        // Layer A: the already-started initial shell. The shell executes the
        // line asynchronously; poll the pane until it has answered rather than
        // asserting against a fixed sleep (the shell's prompt is the event, and
        // a coverage-instrumented run makes any fixed delay a guess).
        mgr.tmux_dep()
            .ops()
            .send_keys(name, "echo \"INITIAL:$NS_CREATE_TEST\"")
            .await
            .expect("the test can ask the shell");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        let mut last_text = String::new();
        loop {
            if let Ok(Some((captured, _, _))) =
                crate::tmux::util::capture_scrollback(&mgr.tmux_dep(), name, 200).await
            {
                last_text = String::from_utf8_lossy(&captured).into_owned();
                if last_text.contains("INITIAL:v") {
                    break;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the initial shell must have the binding, not only future panes: {last_text}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

#[cfg(test)]
mod window_size_lock_tests {
    use super::*;
    use crate::test_support::TestSession;

    async fn read_window_size_option(session: &str) -> Result<String> {
        let out = cmd::global()
            .tokio()
            .args(["show-option", "-t", session, "-v", "window-size"])
            .output()
            .await?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    #[tokio::test]
    async fn create_session_does_not_lock_window_size() {
        // Skip on machines without tmux (CI covers it).
        if cmd::global().tokio().arg("-V").status().await.is_err() {
            eprintln!("tmux not available, skipping");
            return;
        }

        let mgr = SessionManager::new();
        let session = TestSession::new("pinned-size");
        let name = session.name();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();

        mgr.create_session(name, 200, 60, &cwd, &[])
            .await
            .expect("create");

        // window-size stays at tmux's default so the active client can drive
        // rows through the authorized resize path; the *created* size is what
        // must survive an unrelated client, which #2520 applies explicitly.
        let val = read_window_size_option(name).await.expect("show-option");
        assert!(
            val.is_empty() || val == "latest",
            "expected the dynamic window-size policy, got {val:?}"
        );
        let size = mgr
            .tmux_dep()
            .ops()
            .window_size(name)
            .await
            .expect("created window");
        assert_eq!(size, (200, 60), "the requested size must be applied");
        // `session` kills the tmux session on drop, panic or not.
    }

    /// #2520: a client attached to one Session must not size a new Session.
    ///
    /// Reproduced on tmux 3.4 (Ubuntu 24.04): with the default
    /// `window-size latest`, the new Session was created at the attached
    /// client's 80x24 and discarded `-x 96 -y 24`. Nession's server config and
    /// the explicit post-create resize are the fix; this test is the witness.
    #[tokio::test]
    async fn a_client_attached_elsewhere_cannot_size_a_new_session() {
        if cmd::global().tokio().arg("-V").status().await.is_err() {
            eprintln!("tmux not available, skipping");
            return;
        }

        let mgr = SessionManager::new();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();
        let anchor = TestSession::new("client-size-anchor");
        mgr.create_session(anchor.name(), 80, 24, &cwd, &[])
            .await
            .expect("create the anchor");
        // Hold a real 80x24 client on the anchor while the target is created.
        let (_client, _output) =
            crate::tmux::pty::PtySession::attach(&mgr.tmux_dep(), anchor.name(), 80, 24)
                .expect("attach the anchor client");

        let target = TestSession::new("client-size-target");
        mgr.create_session(target.name(), 96, 24, &cwd, &[])
            .await
            .expect("create the target");
        let size = mgr
            .tmux_dep()
            .ops()
            .window_size(target.name())
            .await
            .expect("target window");
        assert_eq!(
            size,
            (96, 24),
            "a client attached to another Session sized the new Session"
        );
    }

    #[tokio::test]
    async fn get_session_cwd_returns_path() {
        if cmd::global().tokio().arg("-V").status().await.is_err() {
            eprintln!("tmux not available, skipping");
            return;
        }

        let mgr = SessionManager::new();
        let session = TestSession::new("cwd");
        let name = session.name();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();

        mgr.create_session(name, 200, 60, &cwd, &[])
            .await
            .expect("create");

        let result = mgr.get_session_cwd(name).await.expect("get_session_cwd");
        // Canonicalize both paths: macOS /var is a symlink to /private/var,
        // and tmux may resolve symlinks differently from std::env::temp_dir().
        let expected = std::fs::canonicalize(&cwd).unwrap_or_else(|_| PathBuf::from(&cwd));
        let actual = std::fs::canonicalize(&result).unwrap_or_else(|_| PathBuf::from(&result));
        assert_eq!(
            actual, expected,
            "CWD should match the session's working directory"
        );
        // `session` kills the tmux session on drop, panic or not.
    }

    #[test]
    fn every_manager_addresses_the_process_socket() {
        // ~60 call sites build a SessionManager with ::new(), and nothing tells
        // them which socket they got. If one stopped inheriting the process-wide
        // one, its sessions would land on a second tmux server: create would
        // succeed, list would not see it, and nothing would report an error.
        assert_eq!(
            SessionManager::new().socket_path(),
            cmd::global().socket_path()
        );
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            SessionManager::with_script_dir(dir.path().to_path_buf()).socket_path(),
            cmd::global().socket_path(),
            "with_script_dir must change only the env-script dir, not the socket"
        );
    }

    #[test]
    fn injecting_a_fake_tmux_keeps_the_socket() {
        // The test seam swaps the binary; a seam that also reset the socket
        // would make fake-tmux tests pass while proving nothing about -S.
        let mut mgr = SessionManager::new();
        let expected = mgr.socket_path().to_path_buf();
        mgr.with_tmux_bin("/nonexistent/fake-tmux");
        assert_eq!(mgr.socket_path(), expected);
    }
}

/// `history-limit` is the agent's decision, made at the one moment it works.
///
/// Separate from `window_size_lock_tests` because the assertion is a different
/// kind: window-size is asserted to be *unset*, this to be *set, to an exact
/// value, early enough to matter*.
#[cfg(test)]
mod history_limit_tests {
    use super::*;
    use crate::test_support::TestSession;
    use crate::tmux::HISTORY_LIMIT_LINES;

    /// The **window's own** history-limit — not the server default, and not the
    /// value the option happens to hold right now.
    ///
    /// That distinction is the whole test, and it was measured rather than
    /// assumed (tmux 3.6b): with the global set to 10000, a window created
    /// under it reports `#{history_limit}` 10000; after the global moves to
    /// 5000 a window created then reports 5000 and the first still reports
    /// 10000. So the number tracks the value **at window creation**, which is
    /// exactly the property `set_history_limit_args` exists for.
    ///
    /// `show-option -t <session> -v history-limit` cannot be used: it reports
    /// the *window-local* setting, which is empty for an option that was only
    /// ever set globally — measured, and the reason this reads a format
    /// instead. `#{history_limit}` is the effective value.
    async fn read_window_history_limit(session: &str) -> Result<String> {
        let out = cmd::global()
            .tokio()
            .args(["display-message", "-p", "-t", session, "#{history_limit}"])
            .output()
            .await?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    #[tokio::test]
    async fn create_session_sets_history_limit_before_the_window_exists() {
        // Skip on machines without tmux (CI covers it).
        if cmd::global().tokio().arg("-V").status().await.is_err() {
            eprintln!("tmux not available, skipping");
            return;
        }

        // `configure` is what writes the server configuration beside the
        // socket, so this test has to run it — the depth arrives through `-f`
        // on an invocation that starts a server, and a socket directory with
        // no config file is the state every other test runs in (harmlessly:
        // tmux tolerates a `-f` naming nothing).
        //
        // It is idempotent and resolves to the same socket `global()` already
        // uses, so running it here does not disturb the tests sharing this
        // process. Reddens without it, which is the point: it is the step that
        // installs the value.
        crate::tmux::cmd::configure(None).expect("configure the tmux addressing");

        let mgr = SessionManager::new();
        let session = TestSession::new("history-limit");
        let name = session.name();
        let cwd = std::env::temp_dir().to_string_lossy().into_owned();

        mgr.create_session(name, 200, 60, &cwd, &[])
            .await
            .expect("create");

        let value = read_window_history_limit(name)
            .await
            .expect("show-option history-limit");
        assert_eq!(
            value,
            HISTORY_LIMIT_LINES.to_string(),
            "the window must be created with nession's depth. This reads the \
             value the window was created under, so tmux's own default here \
             means the call moved after `new-session` — where tmux documents it \
             as a no-op (#321)."
        );
        // `session` kills the tmux session on drop, panic or not.
    }
}

/// The fake-tmux tests for `create_session`'s legacy stage 2.
///
/// `#[cfg(test)]` with per-item `#[cfg(unix)]` rather than `cfg(all(test,
/// unix))` on the module: clippy's `allow-expect-in-tests` (clippy.toml)
/// recognizes a `cfg(test)` module, and spelling the predicate as `all(...)`
/// hides that from it — the module's `.expect(…)` calls then read as
/// production code and the lint gate fails. The items are Unix-only because
/// they write and chmod a `#!/bin/sh` script.
/// Fail-closed Sandbox composition (#2681).
#[cfg(test)]
mod sandbox_refusal_tests {
    use super::*;

    /// A payload that says `enabled: false` while carrying constraints is
    /// contradictory and must be refused, not silently run as Native.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_disabled_policy_with_constraints_is_refused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::test_support::FakeTmux::new(dir.path(), "exit 0");
        let mgr = crate::test_support::manager_with_fake(&fake);
        let session = crate::test_support::TestSession::new("sandbox-disabled");
        let policy: SandboxPolicy = serde_json::from_value(serde_json::json!({
            "enabled": false,
            "network": { "mode": "deny" }
        }))
        .expect("policy fixture");

        let error = mgr
            .create_session_with_options(
                session.name(),
                SESSION_WIDTH,
                SESSION_HEIGHT,
                "/tmp",
                None,
                Some(&policy),
            )
            .await
            .expect_err("a disabled policy with constraints must fail closed");
        assert!(
            format!("{error:#}").contains("disabled sandbox policy"),
            "the refusal must name the contradiction: {error:#}"
        );
        assert!(
            !fake
                .calls()
                .iter()
                .any(|args| args.first().map(String::as_str) == Some("new-session")),
            "no Session may be created for a contradictory policy"
        );
    }

    /// A policy without a composed Sandbox runtime is refused before tmux
    /// creates anything. Falling through to a Native Session would silently
    /// discard the caller's explicitly requested guarantee.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_explicit_policy_without_a_runtime_is_refused_before_create() {
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::test_support::FakeTmux::new(dir.path(), "exit 0");
        let mgr = crate::test_support::manager_with_fake(&fake);
        let session = crate::test_support::TestSession::new("sandbox-no-runtime");
        let policy: SandboxPolicy = serde_json::from_value(serde_json::json!({
            "enabled": true,
            "network": { "mode": "deny" }
        }))
        .expect("policy fixture");

        let error = mgr
            .create_session_with_options(
                session.name(),
                SESSION_WIDTH,
                SESSION_HEIGHT,
                "/tmp",
                None,
                Some(&policy),
            )
            .await
            .expect_err("a policy this Agent cannot honour must fail closed");
        assert!(
            format!("{error:#}").contains("no Sandbox backend configured"),
            "the refusal must name the missing runtime: {error:#}"
        );
        assert!(
            !fake
                .calls()
                .iter()
                .any(|args| args.first().map(String::as_str) == Some("new-session")),
            "no Session may be created for a refused policy"
        );
    }
}

#[cfg(test)]
mod legacy_stage_two_tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn stage_two_types_the_env_line_as_the_owners_argv() {
        // Stage 2 is the path for a tmux older than 3.0, so it cannot be reached
        // on this machine's tmux at all — the fake is what makes the migrated
        // call site observable. It is `let _ =` in production, so nothing else
        // would notice if the line were suddenly sent as five separate
        // keystrokes, or without its `Enter`.
        //
        // Reddens on: dropping `Enter` from `send_keys_args` (the call becomes
        // three entries long plus… → `len() == 5` and the last-entry assertion
        // fail), splitting the line into key names (length), or swapping the
        // `-t` order (the prefix assertion).
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = stage_two_fake(dir.path(), "");
        let mgr = crate::test_support::manager_with_fake(&fake);
        let session = crate::test_support::TestSession::new("stage2-argv");

        mgr.create_session(session.name(), SESSION_WIDTH, SESSION_HEIGHT, "/tmp", &[])
            .await
            .expect("against the fake, create takes its legacy stage-2 path");

        let calls = fake.calls();
        let typed = calls
            .iter()
            .find(|args| args.first().map(String::as_str) == Some("send-keys"))
            .unwrap_or_else(|| panic!("stage 2 must type the environment line: {calls:?}"));

        assert_eq!(
            typed.len(),
            5,
            "send-keys takes the whole line as ONE argument and the trailing \
             Enter is part of the operation: {typed:?}"
        );
        assert_eq!(
            typed[..3].iter().map(String::as_str).collect::<Vec<&str>>(),
            ["send-keys", "-t", session.name()],
            "the session is the target, in the owner's order: {typed:?}"
        );
        assert_eq!(
            typed.last().map(String::as_str),
            Some("Enter"),
            "a line that is typed but never submitted sets nothing: {typed:?}"
        );
        assert!(
            typed[3].starts_with("export TERM='xterm-256color';")
                && typed[3].contains("export LANG='C.UTF-8';"),
            "the line is the export chain stage 2 builds, unchanged: {typed:?}"
        );
    }

    /// The stage-2 fake for the two `Required`/`BestEffort` tests below: it
    /// fails the *first* `new-session` so `create_session` takes its legacy
    /// stage-2 path, then fails whichever subcommands `failures` names, and
    /// succeeds at everything else.
    ///
    /// The first-`new-session` failure is what makes the path observable at all:
    /// on this machine's tmux (3.6b) stage 1 always succeeds, so every
    /// assertion about stage 2 would otherwise be about a path that never ran.
    #[cfg(unix)]
    fn stage_two_fake(dir: &std::path::Path, failures: &str) -> crate::test_support::FakeTmux {
        let stage1 = dir.join("stage1-ran");
        crate::test_support::FakeTmux::new(
            dir,
            &format!(
                "case \"$1\" in\n\
                 new-session)\n\
                   if [ -f \"{s1}\" ]; then exit 0; else : > \"{s1}\"; exit 1; fi;;\n\
                 {failures}\
                 *) exit 0;;\n\
                 esac",
                s1 = stage1.display(),
            ),
        )
    }

    /// The calls the fake recorded for one subcommand, as argv vectors.
    #[cfg(unix)]
    fn calls_of(fake: &crate::test_support::FakeTmux, subcommand: &str) -> Vec<Vec<String>> {
        fake.calls()
            .into_iter()
            .filter(|args| args.first().map(String::as_str) == Some(subcommand))
            .collect()
    }

    #[tokio::test]
    async fn the_binding_environment_reaches_the_session_on_the_fallback_path() {
        // Stage 2 is the tmux < 3.0 path: `new-session -e` is refused and the
        // live shell is given its environment by a `send-keys` line instead.
        // That line is built separately, so nothing about stage 1 covers it —
        // and a session on this path without the variables is one where the
        // hook silently reports nothing, which is the failure this whole stage
        // exists to prevent.
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = stage_two_fake(dir.path(), "");
        let mgr = crate::test_support::manager_with_fake(&fake);
        let session = crate::test_support::TestSession::new("claude-binding-stage2");

        mgr.create_session(session.name(), SESSION_WIDTH, SESSION_HEIGHT, "/tmp", &[])
            .await
            .expect("a refused -e falls back rather than failing");

        let sent = calls_of(&fake, "send-keys")
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join("\n");
        let id_var = nession_claude_code::binding::SESSION_ID_ENV;
        let file_var = nession_claude_code::binding::BINDING_FILE_ENV;

        assert!(
            sent.contains(&format!("{id_var}='{}'", session.name())),
            "the fallback path must export the session id too: {sent}"
        );
        assert!(
            sent.contains(&format!("{file_var}='")),
            "the fallback path must name the binding file too: {sent}"
        );
        assert!(
            sent.contains(&format!("{INSTANCE_ID_ENV}='")),
            "the fallback path must export the instance identity the binding \
             file is fenced by: {sent}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_refused_stage_two_line_fails_the_create() {
        // #991 step 7's one *classification change* on this file's create path:
        // stage 2's `send-keys` was `let _ =` (step 5 left the class open and
        // said so), and it is `Required` now. On the stage-2 path that line is
        // the only thing that gives the live shell the requested environment —
        // stage 3 only reaches windows that do not exist yet — so a create that
        // answered `Ok` after it failed is #980 one stage along.
        //
        // Reddens on: restoring `let _ =` (the `expect_err` below then fails —
        // this is the mutation that pins the class), dropping the
        // `with_context` (the session-naming assertion), and `TmuxOps::send_keys`
        // discarding tmux's stderr (the marker assertion).
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = stage_two_fake(
            dir.path(),
            "send-keys) echo 'injected tmux refuses send-keys' >&2; exit 1;;\n",
        );
        let mgr = crate::test_support::manager_with_fake(&fake);
        let session = crate::test_support::TestSession::new("step7-required-stage2");

        let err = mgr
            .create_session(session.name(), SESSION_WIDTH, SESSION_HEIGHT, "/tmp", &[])
            .await
            .expect_err("a stage-2 line that never ran must fail the create");

        let message = format!("{err:#}");
        assert!(
            message.contains("injected tmux refuses send-keys"),
            "a Required failure carries what tmux said, end to end: {message}"
        );
        assert!(
            message.contains("failed to inject the environment line into session")
                && message.contains(session.name()),
            "and it says which create it was: {message}"
        );
        assert_eq!(
            calls_of(&fake, "new-session").len(),
            2,
            "the create really took the stage-2 path: {:#?}",
            fake.calls()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_refused_cosmetic_stage_two_call_still_creates_the_session() {
        // The other half of the same path, and the contrast the criterion needs:
        // `clear-history` (cosmetic — it hides the `export …` line the
        // statement above typed), the `window-size latest` restore after the
        // create's explicit resize, and `set-option mouse on` (presentation —
        // see the class comment at that call site) are `BestEffort`, and the
        // fake refuses every `set-option` except the create's required instance
        // identity (#2974).
        //
        // Reddens on: making any of those `Required` (the `expect` below then
        // fails), and on removing either recorded call (the assertions fail) —
        // which is what says this test is about those calls and not about the
        // create.
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = stage_two_fake(
            dir.path(),
            "clear-history) echo 'injected tmux refuses clear-history' >&2; exit 1;;\n\
             set-option) case \"$*\" in *@nession_instance_id*) exit 0;; esac; \
             echo 'injected tmux refuses set-option' >&2; exit 1;;\n",
        );
        let mgr = crate::test_support::manager_with_fake(&fake);
        let session = crate::test_support::TestSession::new("step7-best-effort-stage2");

        mgr.create_session(session.name(), SESSION_WIDTH, SESSION_HEIGHT, "/tmp", &[])
            .await
            .expect("a cosmetic failure after a successful primary must not take the create down");

        assert_eq!(
            calls_of(&fake, "clear-history"),
            vec![vec!["clear-history", "-t", session.name()]],
            "the scrollback is still cleared — through the one implementation of \
             that operation, on this manager's own tmux: {:#?}",
            fake.calls()
        );
        let set_options = calls_of(&fake, "set-option");
        for expected in [
            ["set-option", "-t", session.name(), "window-size", "latest"],
            ["set-option", "-t", session.name(), "mouse", "on"],
        ] {
            let expected: Vec<String> = expected.into_iter().map(str::to_string).collect();
            assert!(
                set_options.contains(&expected),
                "the dynamic window-size restore and mouse mode are still requested, \
                 targeted at the session: {:#?}",
                fake.calls()
            );
        }
        // The identity write is the one `set-option` that is *not* best-effort,
        // and it must address this Session by name or it would stamp another
        // Session's durable identity.
        let identity = set_options
            .iter()
            .find(|args| args.get(3).map(String::as_str) == Some(INSTANCE_ID_OPTION))
            .expect("the create records the durable instance identity");
        assert_eq!(
            identity.get(2).map(String::as_str),
            Some(session.name()),
            "the identity write must target this Session: {identity:?}"
        );
    }
}

/// What `with_tmux_bin` substitutes, now that it substitutes more than the
/// manager's own addressing (#991 step 6).
///
/// `#[cfg(test)]` with per-item `#[cfg(unix)]` for the same reason as
/// `legacy_stage_two_tests` above: the fake is a `#!/bin/sh` script, and a
/// `all(test, unix)` predicate on the module would hide the `cfg(test)` from
/// clippy's `allow-expect-in-tests`.
#[cfg(test)]
mod injected_tmux_tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn with_tmux_bin_reaches_the_env_manager_beside_the_manager() {
        // The whole point of step 6, asserted at the seam every existing test
        // already uses. `mgr.env()` reaches an `EnvManager` that resolved
        // `TmuxOps::global()` at each call before this step, so a fake injected
        // here covered `create_session` and stopped: the env operations ran
        // against the real binary on the process socket, and the test could not
        // see it.
        //
        // The assertion is on the fake's own record, not on the error the
        // caller got: an error alone would be produced just as well by real
        // tmux refusing a session that does not exist.
        //
        // The fake's stderr is a marker real tmux never prints, for the same
        // reason: TMUX's own wording for a missing session would satisfy the
        // message assertion whether or not the injection took, so a message
        // that cannot be real tmux's is what makes that assertion mean "the
        // injected binary's words travelled".
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::test_support::FakeTmux::new(
            dir.path(),
            "case \"$1\" in set-environment) echo 'injected tmux refuses nession-fake' >&2; \
             exit 1;; *) exit 0;; esac",
        );
        let mgr = crate::test_support::manager_with_fake(&fake);

        let err = mgr
            .env()
            .set_environment(
                "nession-fake",
                &[("NESSON_WIRED".to_string(), "1".to_string())],
            )
            .await
            .expect_err("the injected binary refuses every set-environment");
        assert!(
            err.to_string()
                .contains("injected tmux refuses nession-fake"),
            "the failure must be the injected binary's: {err}"
        );
        assert_eq!(
            fake.calls(),
            vec![vec![
                "set-environment",
                "-t",
                "nession-fake",
                "NESSON_WIRED",
                "1"
            ]],
            "the env operation must have run on the injected binary"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_claude_binding_environment_reaches_the_session() {
        // #1005. The plugin's hook acts only when both are present, so a session
        // created without them is one where Claude runs and reports nothing —
        // a binding that never appears, and no error anyone can see.
        //
        // The assertion is on the *names* being present with usable values
        // rather than on an exact path: the path comes from the agent's state
        // directory, which a test must not pin to whatever the machine running
        // it happens to have.
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::test_support::FakeTmux::new(dir.path(), "exit 0");
        let mgr = crate::test_support::manager_with_fake(&fake);
        let session = crate::test_support::TestSession::new("claude-binding-env");

        mgr.create_session(session.name(), SESSION_WIDTH, SESSION_HEIGHT, "/tmp", &[])
            .await
            .expect("create");

        let calls = fake.calls();
        let create = calls
            .iter()
            .find(|args| args.first().map(String::as_str) == Some("new-session"))
            .expect("the create ran");
        let argv = create.join("\n");

        let id_var = nession_claude_code::binding::SESSION_ID_ENV;
        let file_var = nession_claude_code::binding::BINDING_FILE_ENV;
        // The name tmux was actually given, which `TestSession` makes unique —
        // asserting the literal passed to it would pass on a machine where no
        // other test had run, and fail everywhere else.
        let name = session.name();

        assert!(
            argv.contains(&format!("{id_var}={name}")),
            "the session id must be the name tmux was given, or the hook binds \
             the wrong session: {argv}"
        );
        assert!(
            argv.contains(&format!("{file_var}=")),
            "the binding file must be named, or the hook has nowhere to write: {argv}"
        );
        assert!(
            argv.contains(&format!("{file_var}=/")),
            "the binding file must be an absolute path — the hook runs from \
             whatever cwd Claude was started in: {argv}"
        );
        assert!(
            argv.contains(&format!("{file_var}=/")),
            "the binding file must be an absolute path: {argv}"
        );
        let binding_line = argv
            .lines()
            .find(|line| line.starts_with(&format!("{file_var}=")))
            .expect("the binding file is named");
        // #2974: the hook must be handed the file of the tmux Session instance
        // this create is making, not a name-derived file a deleted Session of
        // the same name could have written.
        let instance_line = argv
            .lines()
            .find(|line| line.starts_with(&format!("{INSTANCE_ID_ENV}=")))
            .expect("the create delivers the instance identity");
        let instance = instance_line
            .strip_prefix(&format!("{INSTANCE_ID_ENV}="))
            .expect("the line names the variable");
        assert!(
            binding_line.ends_with(&format!(".{instance}.json")),
            "the binding file must be fenced by this Session's instance: {binding_line}"
        );
        assert!(
            binding_line.contains(&format!("/{name}.")),
            "the binding file must be this session's, not a shared one: {binding_line}"
        );
        // The durable owner must hold exactly the id the hook was given, or an
        // Agent restart would derive a different file from the same Session.
        let recorded = calls
            .iter()
            .find(|args| args.get(3).map(String::as_str) == Some(INSTANCE_ID_OPTION))
            .expect("the create records the durable instance identity");
        assert_eq!(
            recorded.get(1).map(String::as_str),
            Some("-t"),
            "the identity write addresses a tmux Session: {recorded:?}"
        );
        assert_eq!(
            recorded.get(2).map(String::as_str),
            Some(name),
            "the identity write must target this Session by name, not another: {recorded:?}"
        );
        assert_eq!(
            recorded.get(4).map(String::as_str),
            Some(instance),
            "the tmux option must hold the id the hook's environment carries: {recorded:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_instance_identity_adopts_the_id_the_create_delivered() {
        // #2974. The durable option is initialized from the id the create
        // delivered to the Session's environment, not from a fresh UUID. That
        // is what keeps a reader racing the create — or a Session whose eager
        // option write was refused — on the exact file the hook was told to
        // write. A fresh id here would silently unbind the Session.
        //
        // The fake is stateful on purpose: the option starts absent, and the
        // read-back after `set-option` is the same operation's proof, so a
        // write that stored the wrong value is visible.
        let dir = tempfile::tempdir().expect("tempdir");
        let state = dir.path().join("instance");
        let delivered = "2f0a6c1e-0d43-4a6e-9f7c-3c1d2e4b5a60";
        let fake = crate::test_support::FakeTmux::new(
            dir.path(),
            &format!(
                "case \"$1\" in\n\
                 show-options) [ -f \"{state}\" ] && cat \"{state}\"; exit 0;;\n\
                 set-option) printf '%s' \"$5\" > \"{state}\"; exit 0;;\n\
                 show-environment) printf '%s\\n' '{INSTANCE_ID_ENV}={delivered}'; exit 0;;\n\
                 *) exit 0;;\n\
                 esac",
                state = state.display(),
            ),
        );
        let mgr = crate::test_support::manager_with_fake(&fake);

        let instance = mgr
            .session_instance_id("delivered-identity")
            .await
            .expect("the identity resolves against the injected tmux");

        assert_eq!(
            instance, delivered,
            "the create-delivered id is adopted, not replaced"
        );
        let stored = fake
            .calls()
            .into_iter()
            .find(|args| args.first().map(String::as_str) == Some("set-option"))
            .and_then(|args| args.last().cloned());
        assert_eq!(
            stored.as_deref(),
            Some(delivered),
            "the delivered id is what the durable option received"
        );
    }

    #[tokio::test]
    async fn best_effort_propagation_reports_a_failure_and_still_creates_the_session() {
        // Stage 3's arm: `propagate_env_best_effort`'s
        // `if let Err(e) = … { tracing::warn!(…) }`. Steps 3–4 classified this
        // `BestEffort` *by experiment* (stage 1 already delivered the value to
        // the shell that exists, so turning this off left the callers' tests
        // green). The fake is what makes the failure observable instead of
        // argued: every `set-environment` it is handed fails — except the
        // create's required instance marker (#2974), whose delivery is a
        // separate, stronger contract — so the propagation arm can only warn
        // and the session is created anyway.
        //
        // Reddens on: making the propagation `Required` (the `expect` below
        // then fails), and on dropping the calls entirely (`propagated` is 0 —
        // which is the mutation that says this test is about the propagation
        // and not about the create).
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::test_support::FakeTmux::new(
            dir.path(),
            "case \"$1\" in \
             set-environment) case \"$*\" in *NESSON_SESSION_INSTANCE_ID*) exit 0;; \
             *) echo 'unknown flag -e' >&2; exit 1;; esac;; \
             *) case \"$*\" in *' -e '*) echo 'no -e support' >&2; exit 1;; \
             *) exit 0;; esac;; esac",
        );
        let mgr = crate::test_support::manager_with_fake(&fake);
        let session = crate::test_support::TestSession::new("step6-best-effort");

        mgr.create_session(session.name(), SESSION_WIDTH, SESSION_HEIGHT, "/tmp", &[])
            .await
            .expect("a best-effort env failure must not take the session create down");

        let calls = fake.calls();
        let propagated = calls
            .iter()
            .filter(|args| args.first().map(String::as_str) == Some("set-environment"))
            .count();
        assert!(
            propagated >= 2,
            "TERM and LANG alone are propagated to future panes, and every one \
             of them failed here: {calls:?}"
        );

        // The control the test needs to mean anything: the *same* binary
        // refuses a required mutation through the *same* manager, so "the
        // create succeeded" above is the BestEffort class and not a tmux that
        // quietly accepted everything. Without this, a fake that never failed
        // would satisfy the assertions above.
        let required = mgr
            .env()
            .set_environment(
                session.name(),
                &[("NESSON_REQUIRED".to_string(), "1".to_string())],
            )
            .await;
        assert!(
            required.is_err(),
            "this fake refuses every set-environment but the identity marker, \
             so the manager's required path must fail on it too: {required:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_refused_kill_carries_tmux_own_words_and_status() {
        // #991's third error criterion, at the one `Required` operation whose
        // failure is a *user-visible sentence*: `agent.session.kill` answers
        // `success: false` with this error's text, and the server's
        // `session.kill` path hands it on. Before step 7 it read
        // `.stderr(Stdio::null())` and bailed with "Failed to kill session:
        // <name>" — the same sentence for a session that does not exist, a
        // server that is gone, and a permission problem.
        //
        // Reddens on: restoring the status-only shape (the marker assertion
        // fails — there is no pipe for tmux to answer on), and on dropping the
        // status from the message (the `exit status` assertion).
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::test_support::FakeTmux::new(
            dir.path(),
            "case \"$1\" in kill-session) echo 'no such session: nession-fake-sess' >&2; exit 1;; \
             *) exit 0;; esac",
        );
        let mgr = crate::test_support::manager_with_fake(&fake);

        let err = mgr
            .kill_session("nession-fake-sess")
            .await
            .expect_err("the injected binary refuses every kill-session");
        let message = format!("{err:#}");
        assert!(
            message.contains("no such session: nession-fake-sess"),
            "the failure must carry tmux's own words — they are what the user \
             ends up reading: {message}"
        );
        assert!(
            message.contains("exit status"),
            "and the exit status beside them: {message}"
        );
        assert_eq!(
            fake.calls(),
            vec![vec!["kill-session", "-t", "nession-fake-sess"]],
            "on the manager's own addressing, one call, tmux's own grammar"
        );
    }
}

/// The per-name create claim's lifecycle, without tmux.
#[cfg(test)]
mod create_claim_tests {
    use super::*;

    #[tokio::test]
    async fn a_claim_is_removed_once_no_create_holds_or_awaits_it() {
        let socket = PathBuf::from("/tmp/nession-create-claim-test.sock");
        let name = "nession-create-claim-test";
        let key = (socket.clone(), name.to_string());

        let permit = creation_permit(&socket, name);
        {
            let slot = permit.slot.clone();
            let _held = slot.lock().await;
        }
        drop(permit);

        {
            let registry = creation_registry()
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            assert!(
                !registry.contains_key(&key),
                "an idle create claim stayed in the registry forever"
            );
        }

        // The next create of the same name claims it again.
        let permit = creation_permit(&socket, name);
        let slot = permit.slot.clone();
        let _held = slot.lock().await;
    }
}

/// #2812: a create that fails after `tmux new-session` has created the
/// Session must reconcile what tmux owns before it reports the failure.
///
/// The fake keeps a small session table on disk (`fake-sessions/<name>`), so
/// "the Session is gone" and "the same name can be created again" are read
/// from state instead of inferred from exit codes. `new-session` records the
/// `NESSON_CREATE_TOKEN` the manager passed; `kill-session` removes the row.
/// A pre-existing row is the identity half: it must survive untouched.
#[cfg(test)]
mod create_recovery_tests {
    use super::*;
    use crate::test_support::{manager_with_fake, unique_session_name, FakeTmux, FAKE_TIMEOUT};
    use nession_protocol::contracts::env::v1::EnvSource;

    /// The ownership fence the manager delivers through `new-session -e`.
    const TOKEN_VAR: &str = "NESSON_CREATE_TOKEN";

    fn session_row(dir: &std::path::Path, name: &str) -> PathBuf {
        dir.join("fake-sessions").join(name)
    }

    /// A fake tmux that owns a tiny session table. `new_session_tail` runs
    /// after a successful create (a marker-gated sleep simulates a call that
    /// outlives the create budget); `extra_cases` adds case arms.
    #[cfg(unix)]
    fn stateful_fake(
        dir: &std::path::Path,
        name: &str,
        new_session_tail: &str,
        extra_cases: &str,
    ) -> FakeTmux {
        let state = dir.join("fake-sessions");
        let script = format!(
            "state='{state}'\n\
             mkdir -p \"$state\"\n\
             name='{name}'\n\
             case \"$1\" in\n\
             list-sessions)\n\
               if [ -f \"$state/$name\" ]; then\n\
                 printf '%s||1700000000|1|0|200|60|/tmp|bash\\n' \"$name\"\n\
               fi\n\
               exit 0;;\n\
             new-session)\n\
               if [ -f \"$state/$name\" ]; then echo \"duplicate session: $name\" >&2; exit 1; fi\n\
               while [ $# -gt 0 ]; do\n\
                 if [ \"$1\" = \"-e\" ]; then\n\
                   shift\n\
                   case \"$1\" in\n\
                     {token_var}=*) printf '%s' \"${{1#{token_var}=}}\" > \"$state/$name.token\";;\n\
                   esac\n\
                 fi\n\
                 shift\n\
               done\n\
               : > \"$state/$name\"\n\
               {tail}\n\
               exit 0;;\n\
             show-environment)\n\
               if [ ! -f \"$state/$name\" ]; then echo \"no such session: $name\" >&2; exit 1; fi\n\
               case \"$4\" in\n\
                 {token_var})\n\
                   if [ -f \"$state/$name.token\" ]; then\n\
                     printf '{token_var}=%s\\n' \"$(cat \"$state/$name.token\")\"\n\
                     exit 0\n\
                   fi;;\n\
               esac\n\
               echo \"unknown variable: $4\" >&2; exit 1;;\n\
             kill-session)\n\
               if [ -f \"$state/$name\" ]; then\n\
                 rm -f \"$state/$name\" \"$state/$name.token\"\n\
                 exit 0\n\
               fi\n\
               echo \"no such session: $name\" >&2; exit 1;;\n\
             {extra_cases}\n\
             *) exit 0;;\n\
             esac\n",
            state = state.display(),
            name = name,
            token_var = TOKEN_VAR,
            tail = new_session_tail,
            extra_cases = extra_cases,
        );
        FakeTmux::new(dir, &script)
    }

    fn profile(name: &str) -> SessionEnvProfile {
        SessionEnvProfile {
            profile: nession_protocol::contracts::env::v1::EnvFileRef {
                name: name.to_string(),
                source: EnvSource::Server,
                agent_id: None,
            },
            phase: "create".to_string(),
            content_hash: None,
        }
    }

    fn snapshot(name: &str) -> EnvSnapshot {
        EnvSnapshot {
            name: name.to_string(),
            source: EnvSource::Server,
            agent_id: None,
            vars: vec![("NS_CREATED".to_string(), "v".to_string())],
            warnings: Vec::new(),
        }
    }

    fn kill_call(name: &str) -> Vec<String> {
        vec![
            "kill-session".to_string(),
            "-t".to_string(),
            name.to_string(),
        ]
    }

    /// SC-01: `new-session` succeeds, the required `resize-window` fails, and
    /// the created Session must not survive to block a retry.
    ///
    /// Reddens before #2812: the create returns Err while the fake still holds
    /// the row, and the retry then fails as a duplicate.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_post_create_resize_failure_removes_the_created_session_and_the_retry_succeeds() {
        let dir = tempfile::tempdir().expect("tempdir");
        let name = unique_session_name("create-resize-failure");
        let fail = dir.path().join("fail-resize");
        std::fs::write(&fail, b"").expect("write the failure marker");
        let fake = stateful_fake(
            dir.path(),
            &name,
            "",
            &format!(
                "resize-window)\n\
                   if [ -f \"{fail}\" ]; then\n\
                     echo 'injected resize failure' >&2\n\
                     exit 1\n\
                   fi;;",
                fail = fail.display()
            ),
        );
        let mgr = manager_with_fake(&fake);

        let error = mgr
            .create_session(&name, 200, 60, "/tmp", &[])
            .await
            .expect_err("a refused post-create resize must fail the create");
        assert!(
            format!("{error:#}").contains("injected resize failure"),
            "the original post-create failure must reach the caller: {error:#}"
        );
        assert!(
            !session_row(dir.path(), &name).exists(),
            "the Session this create made still exists after the create failed"
        );
        assert!(
            fake.calls().iter().any(|call| call == &kill_call(&name)),
            "the failed create must remove its own Session: {:#?}",
            fake.calls()
        );

        std::fs::remove_file(&fail).expect("clear the failure marker");
        mgr.create_session(&name, 200, 60, "/tmp", &[])
            .await
            .expect("a compensated failure must leave the name safe to retry");
        assert!(session_row(dir.path(), &name).exists());
    }

    /// SC-02: a durable binding write fails after tmux created the Session.
    /// The create fails, no binding record is left for the name, and the
    /// Session is gone so a corrected retry succeeds.
    ///
    /// The failure is deterministic: a regular file sits where the Session's
    /// binding directory must be, so `secure_dir` cannot create it. Nothing
    /// is permission-dependent.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_binding_persistence_failure_removes_the_created_session_and_leaves_no_binding() {
        let dir = tempfile::tempdir().expect("tempdir");
        let name = unique_session_name("binding-persist-failure");
        let fake = stateful_fake(dir.path(), &name, "", "");
        let state_dir = dir.path().join("env-state");
        std::fs::create_dir_all(&state_dir).expect("create the state root");
        let blocker = state_dir.join(&name);
        std::fs::write(&blocker, b"not a directory").expect("block the binding directory");

        let mgr = manager_with_fake(&fake).with_env_state_dir(state_dir.clone());
        let snapshots = vec![snapshot("create.env")];
        let profiles = vec![profile("create.env")];
        let input = || SessionBindingInput {
            revision: 1,
            profiles: &profiles,
            snapshots: &snapshots,
        };

        let error = mgr
            .create_session_with_binding(&name, 200, 60, "/tmp", input())
            .await
            .expect_err("a binding that cannot be recorded must fail the create");
        assert!(
            format!("{error:#}").contains("record the Environment Binding"),
            "the failure must name the binding step: {error:#}"
        );
        assert!(
            !session_row(dir.path(), &name).exists(),
            "the Session this create made still exists after the binding failed"
        );
        assert!(
            !state_dir.join(&name).join("binding.json").exists(),
            "a failed create left a durable binding for a Session that does not exist"
        );

        std::fs::remove_file(&blocker).expect("unblock the binding directory");
        mgr.create_session_with_binding(&name, 200, 60, "/tmp", input())
            .await
            .expect("the retry records the binding and creates the Session");
        assert!(session_row(dir.path(), &name).exists());
        assert!(state_dir.join(&name).join("binding.json").exists());
    }

    /// SC-02: the create budget expires while a post-create step is still
    /// running. tmux owns the Session, so the deadline path must reconcile it
    /// rather than report a failure over an untracked live Session.
    ///
    /// Reddens before #2812: the row survives the timeout and the retry is
    /// refused as a duplicate.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_post_create_timeout_removes_the_created_session_and_the_retry_succeeds() {
        let dir = tempfile::tempdir().expect("tempdir");
        let name = unique_session_name("create-timeout");
        let slow = dir.path().join("slow-resize");
        std::fs::write(&slow, b"").expect("write the slow marker");
        let fake = stateful_fake(
            dir.path(),
            &name,
            "",
            &format!(
                // Bounded, marker-controlled wait: the step outlives the
                // create budget, but the test can end it as soon as the
                // timeout has been observed (no fixed sleep lingering past
                // the test).
                "resize-window)\n\
                   i=0\n\
                   while [ -f \"{slow}\" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done;;",
                slow = slow.display()
            ),
        );
        let mut mgr = manager_with_fake(&fake);
        // Comfortably above the pre-check and `new-session` even on a loaded
        // suite, so the deadline lands in the deliberately slow resize.
        mgr.with_timeouts(FAKE_TIMEOUT, FAKE_TIMEOUT, Duration::from_secs(5));

        let error = mgr
            .create_session(&name, 200, 60, "/tmp", &[])
            .await
            .expect_err("a create that exceeds its budget must not report success");
        let message = format!("{error:#}");
        assert!(message.contains("timed out"), "{message}");
        assert!(
            !session_row(dir.path(), &name).exists(),
            "the Session created before the deadline still exists: {message}"
        );

        std::fs::remove_file(&slow).expect("clear the slow marker");
        // The retry is a normal create, so it gets the normal fixture bound:
        // the short budget above exists only to make the timeout happen.
        mgr.with_timeouts(FAKE_TIMEOUT, FAKE_TIMEOUT, FAKE_TIMEOUT);
        mgr.create_session(&name, 200, 60, "/tmp", &[])
            .await
            .expect("a reconciled timeout must leave the name safe to retry");
        assert!(session_row(dir.path(), &name).exists());
    }

    /// SC-02: cancellation while `new-session` was in flight is ambiguous —
    /// the call may have created the Session after the future was dropped.
    /// The creation token proves this attempt's Session, so it is removed.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancelled_create_removes_a_session_it_can_prove_it_created() {
        let dir = tempfile::tempdir().expect("tempdir");
        let name = unique_session_name("create-cancel-owned");
        let slow = dir.path().join("slow-create");
        std::fs::write(&slow, b"").expect("write the slow marker");
        let fake = stateful_fake(
            dir.path(),
            &name,
            &format!(
                // The Session exists and carries the token before the wait;
                // only `new-session`'s return is delayed past the deadline.
                "i=0\n\
                 while [ -f \"{slow}\" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done",
                slow = slow.display()
            ),
            "",
        );
        let mut mgr = manager_with_fake(&fake);
        mgr.with_timeouts(FAKE_TIMEOUT, FAKE_TIMEOUT, Duration::from_secs(5));

        let error = mgr
            .create_session(&name, 200, 60, "/tmp", &[])
            .await
            .expect_err("the create exceeded its budget");
        let message = format!("{error:#}");
        assert!(message.contains("timed out"), "{message}");
        assert!(
            !session_row(dir.path(), &name).exists(),
            "a Session this create provably made survived cancellation: {message}"
        );
        assert!(
            fake.calls().iter().any(|call| call == &kill_call(&name)),
            "the reconciliation must remove the proven Session: {:#?}",
            fake.calls()
        );

        std::fs::remove_file(&slow).expect("clear the slow marker");
        // The retry is a normal create, so it gets the normal fixture bound:
        // the short budget above exists only to make the deadline fire.
        mgr.with_timeouts(FAKE_TIMEOUT, FAKE_TIMEOUT, FAKE_TIMEOUT);
        mgr.create_session(&name, 200, 60, "/tmp", &[])
            .await
            .expect("the cancelled create left a retryable name");
    }

    /// SC-02: a same-named Session that this attempt cannot prove it created
    /// is not killed; the failure says so instead of leaving it silently
    /// untracked.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_cancelled_create_that_cannot_prove_ownership_leaves_the_session_and_says_so() {
        let dir = tempfile::tempdir().expect("tempdir");
        let name = unique_session_name("create-cancel-foreign");
        let state = session_row(dir.path(), &name);
        let killed = dir.path().join("kill-ran");
        let hold = dir.path().join("hold-create");
        std::fs::write(&hold, b"").expect("write the hold marker");
        // A `tmux` whose `new-session` creates a Session without this
        // attempt's token, then outlives the create budget. This is the shape
        // of an external creator on the same socket, or of a legacy path that
        // could not deliver the token before the deadline.
        let script = format!(
            r#"mkdir -p "{state_dir}"
case "$1" in
list-sessions) if [ -f "{state}" ]; then printf '%s||1700000000|1|0|200|60|/tmp|bash\n' "{name}"; fi; exit 0;;
new-session) : > "{state}"; i=0; while [ -f "{hold}" ] && [ $i -lt 400 ]; do sleep 0.05; i=$((i+1)); done; exit 0;;
show-environment) echo "unknown variable: $4" >&2; exit 1;;
kill-session) : > "{killed}"; exit 0;;
*) exit 0;;
esac"#,
            state_dir = state.parent().expect("state parent").display(),
            state = state.display(),
            name = name,
            hold = hold.display(),
            killed = killed.display(),
        );
        let fake = FakeTmux::new(dir.path(), &script);
        let mut mgr = manager_with_fake(&fake);
        mgr.with_timeouts(FAKE_TIMEOUT, FAKE_TIMEOUT, Duration::from_secs(5));

        let error = mgr
            .create_session(&name, 200, 60, "/tmp", &[])
            .await
            .expect_err("the create exceeded its budget");
        let message = format!("{error:#}");
        assert!(
            message.contains("could not be proven"),
            "an unprovable live Session must be reported, not silently left: {message}"
        );
        assert!(
            state.exists(),
            "an unowned same-named Session was killed by the failing create"
        );
        assert!(
            !killed.exists(),
            "the reconciliation issued kill-session for a Session it could not prove was its own"
        );

        std::fs::remove_file(&hold).expect("release the abandoned new-session");
        std::fs::remove_file(&state).expect("clean up the simulated Session");
    }

    /// SC-02: the SDK's legacy fallback (`-e` refused, then the environment
    /// typed into the shell) can create the Session and fail while typing it.
    /// The token travels in that line, so the Session cannot be proven to be
    /// this attempt's; it is left untouched and the error states that instead
    /// of leaving it silently untracked.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_fallback_create_that_cannot_deliver_the_token_reports_the_session_it_left() {
        let dir = tempfile::tempdir().expect("tempdir");
        let name = unique_session_name("create-fallback-leftover");
        let state = session_row(dir.path(), &name);
        let killed = dir.path().join("kill-ran");
        let script = format!(
            r#"mkdir -p "{state_dir}"
case "$1" in
list-sessions) if [ -f "{state}" ]; then printf '%s||1700000000|1|0|200|60|/tmp|bash\n' "{name}"; fi; exit 0;;
new-session)
  for arg in "$@"; do
    if [ "$arg" = "-e" ]; then echo "unknown flag -e" >&2; exit 1; fi
  done
  : > "{state}"
  exit 0;;
send-keys) echo "injected send-keys failure" >&2; exit 1;;
show-environment) echo "unknown variable: $4" >&2; exit 1;;
kill-session) : > "{killed}"; exit 0;;
*) exit 0;;
esac"#,
            state_dir = state.parent().expect("state parent").display(),
            state = state.display(),
            name = name,
            killed = killed.display(),
        );
        let fake = FakeTmux::new(dir.path(), &script);
        let mgr = manager_with_fake(&fake);

        let error = mgr
            .create_session(&name, 200, 60, "/tmp", &[])
            .await
            .expect_err("a fallback that cannot deliver its environment fails the create");
        let message = format!("{error:#}");
        assert!(
            message.contains("injected send-keys failure"),
            "the original fallback failure must reach the caller: {message}"
        );
        assert!(
            message.contains("could not be proven"),
            "an unprovable leftover must be reported, not silently left: {message}"
        );
        assert!(
            state.exists(),
            "the Session this attempt could not prove was its own was removed"
        );
        assert!(
            !killed.exists(),
            "the reconciliation killed a Session it could not prove was its own"
        );

        std::fs::remove_file(&state).expect("clean up the simulated Session");
    }

    /// SC-02: a Session that existed before this create is never the create's
    /// to remove. The refusal is deterministic and the row survives.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_pre_existing_same_named_session_is_not_touched() {
        let dir = tempfile::tempdir().expect("tempdir");
        let name = unique_session_name("preexisting");
        let fake = stateful_fake(dir.path(), &name, "", "");
        let state = session_row(dir.path(), &name);
        std::fs::create_dir_all(state.parent().expect("state parent")).expect("state dir");
        std::fs::write(&state, b"pre-existing").expect("pre-existing Session");

        let mgr = manager_with_fake(&fake);
        let error = mgr
            .create_session(&name, 200, 60, "/tmp", &[])
            .await
            .expect_err("a name that already exists cannot be created");
        assert!(
            format!("{error:#}").contains("already exists"),
            "the refusal must name the duplicate: {error:#}"
        );
        assert!(
            state.exists(),
            "the pre-existing Session was removed by a create that never owned it"
        );
        assert!(
            !fake
                .calls()
                .iter()
                .any(|call| call.first().map(String::as_str) == Some("kill-session")),
            "the create issued kill-session for a Session it did not make: {:#?}",
            fake.calls()
        );
    }

    /// SC-03: the success path keeps the requested geometry, records the
    /// durable binding, and leaves the Session discoverable. The failure
    /// recovery must not turn a normal create into a different outcome.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_successful_create_with_a_binding_keeps_geometry_binding_and_discovery() {
        let dir = tempfile::tempdir().expect("tempdir");
        let name = unique_session_name("create-success");
        let fake = stateful_fake(dir.path(), &name, "", "");
        let state_dir = dir.path().join("env-state");
        let mgr = manager_with_fake(&fake).with_env_state_dir(state_dir.clone());
        let snapshots = vec![snapshot("create.env")];
        let profiles = vec![profile("create.env")];

        let outcome = mgr
            .create_session_with_binding(
                &name,
                200,
                60,
                "/tmp",
                SessionBindingInput {
                    revision: 1,
                    profiles: &profiles,
                    snapshots: &snapshots,
                },
            )
            .await
            .expect("a healthy create succeeds");
        assert!(outcome.warnings.is_empty(), "{:?}", outcome.warnings);

        assert!(
            fake.calls().iter().any(|call| call
                == &vec![
                    "resize-window".to_string(),
                    "-t".to_string(),
                    name.clone(),
                    "-x".to_string(),
                    "200".to_string(),
                    "-y".to_string(),
                    "60".to_string()
                ]),
            "the requested geometry was not applied: {:#?}",
            fake.calls()
        );
        let binding = std::fs::read(state_dir.join(&name).join("binding.json"))
            .expect("the durable binding is recorded");
        let binding: serde_json::Value = serde_json::from_slice(&binding).expect("binding JSON");
        assert_eq!(binding["applied_revision"], 1);
        assert_eq!(binding["session_name"], serde_json::json!(name));
        assert!(
            mgr.list_sessions()
                .await
                .expect("the Session is discoverable")
                .iter()
                .any(|session| session.name == name),
            "the created Session is not discoverable"
        );
        let observed = mgr
            .env()
            .observe(&name)
            .await
            .expect("the binding is observable");
        assert_eq!(observed.applied_revision, 1);
    }
}
