use std::io;
use std::path::{Path, PathBuf};

/// Environment variable that overrides the nession home directory.
/// When set, durable paths (server dir, agent dir, DB, identity, Session
/// metadata, etc.) are resolved relative to this directory instead of
/// `$HOME/.nession`.
pub const NESSION_HOME_ENV: &str = "NESSION_HOME";

/// Environment variable that overrides the Nession runtime directory.
///
/// The value is the directory itself — not a parent to append `nession` to —
/// and it must be an absolute path. It never resolves relative to
/// [`NESSION_HOME_ENV`]: process-lifecycle state must not follow durable
/// project data, an installed binary version, or archived configuration.
pub const NESSION_RUNTIME_DIR_ENV: &str = "NESSION_RUNTIME_DIR";

/// The Nession-owned directory inside the OS runtime root.
pub const RUNTIME_DIR_NAME: &str = "nession";

/// Root directory for durable nession data.
///
/// Resolution order:
/// 1. `$NESSION_HOME` env var — if set, use it directly
/// 2. `$HOME/.nession` — standard XDG-style default
///
/// This governs durable state only. Ephemeral process state (PID files and
/// readiness markers) is resolved by [`runtime_dir`] instead.
pub fn nession_home() -> io::Result<PathBuf> {
    if let Ok(home) = std::env::var(NESSION_HOME_ENV) {
        if !home.is_empty() {
            return Ok(PathBuf::from(home));
        }
    }
    dirs::home_dir().map(|h| h.join(".nession")).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "could not determine home directory (set NESSION_HOME or ensure HOME is set)",
        )
    })
}

/// Server component directory: ~/.nession/server
pub fn server_dir() -> io::Result<PathBuf> {
    nession_home().map(|h| h.join("server"))
}

/// Agent component directory: ~/.nession/agent
pub fn agent_dir() -> io::Result<PathBuf> {
    nession_home().map(|h| h.join("agent"))
}

/// Server database path: ~/.nession/server/server.db
pub fn server_db_path() -> io::Result<PathBuf> {
    server_dir().map(|d| d.join("server.db"))
}

/// The OS runtime directory for Nession process-lifecycle state.
///
/// Resolution order:
/// 1. `$NESSION_RUNTIME_DIR`, which must be absolute, used verbatim;
/// 2. Linux root → `/run/nession`;
/// 3. Linux ordinary user → `$XDG_RUNTIME_DIR/nession`;
/// 4. macOS → the Darwin per-user temporary directory plus `nession`;
/// 5. otherwise an actionable error — never a durable home directory or a
///    shared world-writable `/tmp`.
///
/// The directory may not exist yet; [`ensure_runtime_dir`] creates it with
/// private permissions and rejects an unsafe location.
pub fn runtime_dir() -> io::Result<PathBuf> {
    resolve_runtime_dir(&RuntimeContext::from_process()).map(|resolved| resolved.dir)
}

/// Resolve and create the private Nession runtime directory.
///
/// The directory is created with owner-only permissions (`0700` on Unix). An
/// existing directory must be a real, current-user-owned directory; symlinks
/// and other owners are rejected rather than trusted with PID or lifecycle
/// artifacts.
pub fn ensure_runtime_dir() -> io::Result<PathBuf> {
    let resolved = resolve_runtime_dir(&RuntimeContext::from_process())?;
    prepare_runtime_dir(&resolved)?;
    Ok(resolved.dir)
}

/// Server PID file path: `<runtime_dir>/server.pid`
///
/// PID state is ephemeral process lifecycle state, not durable Server data, so
/// it does not live under [`server_dir`].
pub fn server_pid_path() -> io::Result<PathBuf> {
    runtime_dir().map(|d| d.join("server.pid"))
}

/// Agent PID file path: `<runtime_dir>/agent.pid`
pub fn agent_pid_path() -> io::Result<PathBuf> {
    runtime_dir().map(|d| d.join("agent.pid"))
}

/// Where pre-runtime versions kept the Server PID file: ~/.nession/server/server.pid
///
/// Kept as an explicit migration location. It is never the default for new
/// state; the CLI uses it only to discover a still-live daemon started by an
/// older binary.
pub fn legacy_server_pid_path() -> io::Result<PathBuf> {
    server_dir().map(|d| d.join("server.pid"))
}

/// Where pre-runtime versions kept the Agent PID file: ~/.nession/agent/agent.pid
pub fn legacy_agent_pid_path() -> io::Result<PathBuf> {
    agent_dir().map(|d| d.join("agent.pid"))
}

/// Where Claude Code integrations report their bindings: ~/.nession/agent/claude
///
/// One file per Nession session, written by the hook the agent installs and read
/// by the agent when it is asked which Claude conversation a session is running
/// (`#1005`). Under the agent's directory because it is the agent's state: it
/// describes which sessions *this* agent started, and it is meaningless to any
/// other.
pub fn agent_claude_bindings_dir() -> io::Result<PathBuf> {
    agent_dir().map(|d| d.join("claude"))
}

/// Server env-file directory: ~/.nession/server/envs
pub fn server_envs_dir() -> io::Result<PathBuf> {
    server_dir().map(|d| d.join("envs"))
}

/// Agent env-file directory: ~/.nession/agent/envs
pub fn agent_envs_dir() -> io::Result<PathBuf> {
    agent_dir().map(|d| d.join("envs"))
}

/// Durable Session Environment Binding state: ~/.nession/agent/env-bindings
///
/// One directory per Session holding the Agent's observed binding record, the
/// generated shell overlay, and the revision files. It must outlive an Agent
/// process because the tmux Sessions do; see `docs/architecture/session-env-binding.md`
/// for the secret-copy consequence of the baseline values stored here.
pub fn agent_env_bindings_dir() -> io::Result<PathBuf> {
    agent_dir().map(|d| d.join("env-bindings"))
}

/// Server logs directory: ~/.nession/server/logs
pub fn server_logs_dir() -> io::Result<PathBuf> {
    server_dir().map(|d| d.join("logs"))
}

/// Agent logs directory: ~/.nession/agent/logs
/// Durable Session metadata: ~/.nession/agent/sessions
///
/// One directory per tmux Session instance, keyed by the opaque
/// `@nession_instance_id` user option (#2789). It must outlive an Agent
/// process because the tmux Sessions do; a kill/recreate starts under a new
/// instance id and cannot inherit the previous instance's directory.
pub fn agent_sessions_dir() -> io::Result<PathBuf> {
    agent_dir().map(|d| d.join("sessions"))
}

pub fn agent_logs_dir() -> io::Result<PathBuf> {
    agent_dir().map(|d| d.join("logs"))
}

/// Agent identity file path: ~/.nession/agent/identity
pub fn agent_identity_path() -> io::Result<PathBuf> {
    agent_dir().map(|d| d.join("identity"))
}

/// Agent default config path: ~/.nession/agent-config.toml
pub fn agent_config_path() -> io::Result<PathBuf> {
    nession_home().map(|h| h.join("agent-config.toml"))
}

/// Server default config path: ~/.nession/server-config.toml
pub fn server_config_path() -> io::Result<PathBuf> {
    nession_home().map(|h| h.join("server-config.toml"))
}

/// Create server and agent component directories (including logs) if they
/// don't exist.
pub fn ensure_component_dirs() -> io::Result<()> {
    std::fs::create_dir_all(server_dir()?)?;
    std::fs::create_dir_all(server_logs_dir()?)?;
    std::fs::create_dir_all(agent_dir()?)?;
    std::fs::create_dir_all(agent_logs_dir()?)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Runtime-directory resolution
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimePlatform {
    Linux,
    Darwin,
    Other,
}

/// The inputs `runtime_dir` resolves against.
///
/// Split from the environment reads so every row of the platform contract can
/// be proven deterministically on any host, not only the row the test happens
/// to run on.
#[derive(Debug, Clone)]
struct RuntimeContext {
    override_dir: Option<String>,
    platform: RuntimePlatform,
    /// `$XDG_RUNTIME_DIR` on Linux, the Darwin per-user temporary directory on
    /// macOS. `None` when the OS provides no usable value.
    os_runtime_base: Option<PathBuf>,
    effective_uid: u32,
}

impl RuntimeContext {
    fn from_process() -> Self {
        let platform = if cfg!(target_os = "linux") {
            RuntimePlatform::Linux
        } else if cfg!(target_os = "macos") {
            RuntimePlatform::Darwin
        } else {
            RuntimePlatform::Other
        };
        Self {
            override_dir: std::env::var(NESSION_RUNTIME_DIR_ENV).ok(),
            platform,
            os_runtime_base: os_runtime_base(),
            effective_uid: effective_uid(),
        }
    }
}

#[cfg(target_os = "linux")]
fn os_runtime_base() -> Option<PathBuf> {
    std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg(target_os = "macos")]
fn os_runtime_base() -> Option<PathBuf> {
    darwin_user_temp_dir()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn os_runtime_base() -> Option<PathBuf> {
    None
}

#[cfg(target_os = "macos")]
fn darwin_user_temp_dir() -> Option<PathBuf> {
    if let Some(value) = std::env::var_os("_CS_DARWIN_USER_TEMP_DIR") {
        if !value.is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    // The environment variable is the common case; `confstr` is the
    // authoritative source when launchd did not export it.
    let mut buffer = vec![0u8; 4096];
    // SAFETY: `confstr` writes at most `buffer.len()` bytes into `buffer`.
    let len = unsafe {
        libc::confstr(
            libc::_CS_DARWIN_USER_TEMP_DIR,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
        )
    };
    if len == 0 || len > buffer.len() {
        return None;
    }
    let text = std::str::from_utf8(buffer.get(..len - 1)?).ok()?.trim();
    (!text.is_empty()).then(|| PathBuf::from(text))
}

#[cfg(unix)]
fn effective_uid() -> u32 {
    // SAFETY: `geteuid` has no preconditions and reads process-global state.
    unsafe { libc::geteuid() }
}

#[cfg(not(unix))]
fn effective_uid() -> u32 {
    0
}

/// A resolved runtime directory plus the OS container it came from, when the
/// path was not supplied by `NESSION_RUNTIME_DIR`.
#[derive(Debug, Clone)]
struct ResolvedRuntimeDir {
    dir: PathBuf,
    os_base: Option<PathBuf>,
}

fn resolve_runtime_dir(context: &RuntimeContext) -> io::Result<ResolvedRuntimeDir> {
    if let Some(raw) = context.override_dir.as_deref() {
        let raw = raw.trim();
        if !raw.is_empty() {
            let path = PathBuf::from(raw);
            if !path.is_absolute() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "{NESSION_RUNTIME_DIR_ENV} must be an absolute path, but is '{raw}'; \
                         process state is never resolved relative to the current directory"
                    ),
                ));
            }
            return Ok(ResolvedRuntimeDir {
                dir: path,
                os_base: None,
            });
        }
    }

    match context.platform {
        RuntimePlatform::Linux if context.effective_uid == 0 => Ok(ResolvedRuntimeDir {
            dir: Path::new("/run").join(RUNTIME_DIR_NAME),
            os_base: Some(PathBuf::from("/run")),
        }),
        // An ordinary Linux user without a valid XDG runtime directory has no
        // safe default: falling back to the durable home or a world-writable
        // /tmp would let a reboot-archived or shared location serve as
        // process-ownership evidence.
        RuntimePlatform::Linux => linux_user_runtime_dir(context),
        RuntimePlatform::Darwin => darwin_user_runtime_dir(context),
        RuntimePlatform::Other => Err(unsupported_runtime(format!(
            "this platform has no supported OS runtime directory for Nession process state; \
             set {NESSION_RUNTIME_DIR_ENV} to an absolute, user-owned directory"
        ))),
    }
}

fn linux_user_runtime_dir(context: &RuntimeContext) -> io::Result<ResolvedRuntimeDir> {
    let Some(base) = context.os_runtime_base.as_deref() else {
        return Err(unsupported_runtime(format!(
            "XDG_RUNTIME_DIR is not set; set {NESSION_RUNTIME_DIR_ENV} to an absolute, \
             user-owned directory (for example /run/user/1000/{RUNTIME_DIR_NAME})"
        )));
    };
    runtime_dir_under(base, "XDG_RUNTIME_DIR")
}

fn darwin_user_runtime_dir(context: &RuntimeContext) -> io::Result<ResolvedRuntimeDir> {
    let Some(base) = context.os_runtime_base.as_deref() else {
        return Err(unsupported_runtime(format!(
            "the Darwin per-user temporary directory is unavailable; set \
             {NESSION_RUNTIME_DIR_ENV} to an absolute, user-owned directory"
        )));
    };
    runtime_dir_under(base, "the Darwin per-user temporary directory")
}

fn runtime_dir_under(base: &Path, source: &str) -> io::Result<ResolvedRuntimeDir> {
    if !base.is_absolute() {
        return Err(unsupported_runtime(format!(
            "{source} is not an absolute path ('{}'); set {NESSION_RUNTIME_DIR_ENV} to an \
             absolute, user-owned directory",
            base.display()
        )));
    }
    Ok(ResolvedRuntimeDir {
        dir: base.join(RUNTIME_DIR_NAME),
        os_base: Some(base.to_path_buf()),
    })
}

fn unsupported_runtime(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::Unsupported, message)
}

// ---------------------------------------------------------------------------
// Runtime-directory creation and safety
// ---------------------------------------------------------------------------

fn prepare_runtime_dir(resolved: &ResolvedRuntimeDir) -> io::Result<()> {
    #[cfg(unix)]
    {
        // The OS runtime root is the container this user's private directory
        // is created in. If it is owned by someone else or writable by them,
        // the final directory's ownership check below cannot make it safe. An
        // explicit NESSION_RUNTIME_DIR is the operator's own choice; only its
        // final directory is validated.
        if let Some(base) = resolved.os_base.as_deref() {
            validate_runtime_base(base)?;
        }
        std::fs::create_dir_all(&resolved.dir)?;
        make_private(&resolved.dir)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(&resolved.dir)
    }
}

#[cfg(unix)]
fn validate_runtime_base(base: &Path) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;

    let metadata = std::fs::metadata(base).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!(
                "Nession runtime root {} is not usable: {error}; set {NESSION_RUNTIME_DIR_ENV} \
                 to an absolute, user-owned directory",
                base.display()
            ),
        )
    })?;
    if !metadata.is_dir() {
        return Err(unsafe_runtime(format!(
            "Nession runtime root {} is not a directory",
            base.display()
        )));
    }
    if metadata.uid() != effective_uid() {
        return Err(unsafe_runtime(format!(
            "Nession runtime root {} is owned by uid {}, not the current user (uid {})",
            base.display(),
            metadata.uid(),
            effective_uid()
        )));
    }
    if metadata.mode() & 0o022 != 0 {
        return Err(unsafe_runtime(format!(
            "Nession runtime root {} is writable by group or other users; set \
             {NESSION_RUNTIME_DIR_ENV} to a private directory",
            base.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn make_private(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let metadata = std::fs::symlink_metadata(dir)?;
    if metadata.file_type().is_symlink() {
        return Err(unsafe_runtime(format!(
            "Nession runtime directory {} is a symlink; refusing to place process state there",
            dir.display()
        )));
    }
    if !metadata.is_dir() {
        return Err(unsafe_runtime(format!(
            "Nession runtime directory {} is not a directory",
            dir.display()
        )));
    }
    if metadata.uid() != effective_uid() {
        return Err(unsafe_runtime(format!(
            "Nession runtime directory {} is owned by uid {}, not the current user (uid {})",
            dir.display(),
            metadata.uid(),
            effective_uid()
        )));
    }
    if metadata.mode() & 0o077 != 0 {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    // Re-read: a directory that did not become private is not a location this
    // process may trust with ownership evidence.
    let metadata = std::fs::symlink_metadata(dir)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
    {
        return Err(unsafe_runtime(format!(
            "Nession runtime directory {} could not be made owner-private (0700)",
            dir.display()
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn unsafe_runtime(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serialise tests that touch process-global environment variables — Rust
    /// runs tests in parallel by default, and `set_var`/`remove_var` are
    /// process-global (not thread-safe).
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        ENV_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Set an environment variable for the duration of a test, restoring the
    /// previous value even if the test panics.
    struct EnvSetting {
        key: &'static str,
        previous: Option<std::ffi::OsString>,
    }

    impl EnvSetting {
        fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
            let previous = std::env::var_os(key);
            std::env::set_var(key, value);
            Self { key, previous }
        }

        fn unset(key: &'static str) -> Self {
            let previous = std::env::var_os(key);
            std::env::remove_var(key);
            Self { key, previous }
        }
    }

    impl Drop for EnvSetting {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(previous) => std::env::set_var(self.key, previous),
                None => std::env::remove_var(self.key),
            }
        }
    }

    fn context(
        platform: RuntimePlatform,
        effective_uid: u32,
        os_runtime_base: Option<&str>,
    ) -> RuntimeContext {
        RuntimeContext {
            override_dir: None,
            platform,
            os_runtime_base: os_runtime_base.map(PathBuf::from),
            effective_uid,
        }
    }

    #[test]
    fn test_nession_home() {
        let _guard = lock_env();
        let home = nession_home().unwrap();
        assert!(home.to_string_lossy().ends_with(".nession"));
    }

    #[test]
    fn test_nession_home_env_override() {
        let _guard = lock_env();
        let dir = tempfile::tempdir().unwrap();
        let tmp = dir.path().to_path_buf();
        let _setting = EnvSetting::set(NESSION_HOME_ENV, &tmp);
        let home = nession_home().unwrap();
        assert_eq!(home, tmp);
    }

    #[test]
    fn test_server_dir() {
        let _guard = lock_env();
        let dir = server_dir().unwrap();
        assert!(dir.to_string_lossy().ends_with("server"));
    }

    #[test]
    fn test_agent_dir() {
        let _guard = lock_env();
        let dir = agent_dir().unwrap();
        assert!(dir.to_string_lossy().ends_with("agent"));
    }

    #[test]
    fn test_server_db_path() {
        let _guard = lock_env();
        let path = server_db_path().unwrap();
        assert!(path.to_string_lossy().ends_with("server.db"));
    }

    #[test]
    fn test_server_envs_dir() {
        let _guard = lock_env();
        let dir = server_envs_dir().unwrap();
        assert!(dir.to_string_lossy().ends_with("envs"));
    }

    #[test]
    fn test_agent_envs_dir() {
        let _guard = lock_env();
        let dir = agent_envs_dir().unwrap();
        assert!(dir.to_string_lossy().ends_with("envs"));
    }

    #[test]
    fn test_agent_identity_path() {
        let _guard = lock_env();
        let path = agent_identity_path().unwrap();
        assert!(path.to_string_lossy().ends_with("identity"));
        assert!(path.to_string_lossy().contains("agent"));
    }

    #[test]
    fn test_agent_config_path() {
        let _guard = lock_env();
        let path = agent_config_path().unwrap();
        assert!(path.to_string_lossy().ends_with("agent-config.toml"));
    }

    #[test]
    fn test_server_config_path() {
        let _guard = lock_env();
        let path = server_config_path().unwrap();
        assert!(path.to_string_lossy().ends_with("server-config.toml"));
    }

    #[test]
    fn the_runtime_override_is_used_verbatim() {
        let mut context = context(RuntimePlatform::Linux, 1000, Some("/run/user/1000"));
        context.override_dir = Some("/var/tmp/nession-runtime".to_string());

        assert_eq!(
            resolve_runtime_dir(&context).unwrap().dir,
            PathBuf::from("/var/tmp/nession-runtime")
        );
    }

    #[test]
    fn a_relative_runtime_override_is_rejected() {
        let mut context = context(RuntimePlatform::Linux, 1000, Some("/run/user/1000"));
        context.override_dir = Some("relative/nession-runtime".to_string());

        let error = resolve_runtime_dir(&context).expect_err("a relative override is unsafe");
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(
            error.to_string().contains("absolute"),
            "the error must say the override has to be absolute: {error}"
        );
    }

    #[test]
    fn a_linux_user_uses_the_xdg_runtime_directory() {
        let context = context(RuntimePlatform::Linux, 1000, Some("/run/user/1000"));

        assert_eq!(
            resolve_runtime_dir(&context).unwrap().dir,
            PathBuf::from("/run/user/1000/nession")
        );
    }

    #[test]
    fn linux_root_uses_the_system_runtime_directory() {
        let context = context(RuntimePlatform::Linux, 0, None);

        assert_eq!(
            resolve_runtime_dir(&context).unwrap().dir,
            PathBuf::from("/run/nession")
        );
    }

    #[test]
    fn a_linux_user_without_xdg_gets_an_actionable_error() {
        let context = context(RuntimePlatform::Linux, 1000, None);

        let error = resolve_runtime_dir(&context).expect_err("no safe Linux default exists");
        let message = error.to_string();
        assert!(
            message.contains(NESSION_RUNTIME_DIR_ENV),
            "the error must name the override: {message}"
        );
        assert!(
            !message.contains(".nession"),
            "the error must not suggest a durable home fallback: {message}"
        );
    }

    #[test]
    fn a_relative_xdg_runtime_dir_is_rejected() {
        let context = context(RuntimePlatform::Linux, 1000, Some("run/user/1000"));

        let error = resolve_runtime_dir(&context).expect_err("a relative XDG path is unsafe");
        assert!(
            error.to_string().contains("absolute"),
            "the error must say the OS runtime root has to be absolute: {error}"
        );
    }

    #[test]
    fn a_macos_user_uses_the_darwin_user_temporary_directory() {
        let context = context(RuntimePlatform::Darwin, 501, Some("/var/folders/xy/T/"));

        assert_eq!(
            resolve_runtime_dir(&context).unwrap().dir,
            PathBuf::from("/var/folders/xy/T/nession")
        );
    }

    #[test]
    fn a_macos_user_without_a_user_temporary_directory_gets_an_actionable_error() {
        let context = context(RuntimePlatform::Darwin, 501, None);

        let error = resolve_runtime_dir(&context).expect_err("no safe Darwin default exists");
        assert!(
            error.to_string().contains(NESSION_RUNTIME_DIR_ENV),
            "the error must name the override: {error}"
        );
    }

    #[test]
    fn an_unsupported_platform_requires_the_override() {
        let context = context(RuntimePlatform::Other, 1000, None);

        let error = resolve_runtime_dir(&context).expect_err("no platform default exists");
        assert!(
            error.to_string().contains(NESSION_RUNTIME_DIR_ENV),
            "the error must name the override: {error}"
        );
    }

    #[test]
    fn runtime_resolution_does_not_follow_nession_home() {
        let _guard = lock_env();
        let home = tempfile::tempdir().unwrap();
        let runtime = tempfile::tempdir().unwrap();
        let _home = EnvSetting::set(NESSION_HOME_ENV, home.path());
        let _runtime = EnvSetting::set(NESSION_RUNTIME_DIR_ENV, runtime.path());

        let resolved = runtime_dir().unwrap();

        assert_eq!(resolved, runtime.path());
        assert!(
            !resolved.starts_with(home.path()),
            "durable home must not redirect runtime state: {resolved:?}"
        );
    }

    /// The actual Darwin default, not a simulated context row: the per-user
    /// temporary directory must be a real absolute directory the OS provides.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_real_darwin_runtime_root_is_a_user_temporary_directory() {
        let _guard = lock_env();
        let _override = EnvSetting::unset(NESSION_RUNTIME_DIR_ENV);

        let dir = runtime_dir().expect("macOS provides a per-user temporary directory");

        assert!(dir.is_absolute(), "{dir:?}");
        assert!(dir.ends_with(RUNTIME_DIR_NAME), "{dir:?}");
        let base = dir.parent().expect("runtime dir has an OS root");
        assert!(
            std::fs::metadata(base).unwrap().is_dir(),
            "the Darwin user temporary root must exist: {base:?}"
        );
    }

    /// The actual Linux user default when the runner provides XDG_RUNTIME_DIR.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_real_linux_runtime_root_uses_xdg_when_available() {
        let _guard = lock_env();
        let _override = EnvSetting::unset(NESSION_RUNTIME_DIR_ENV);
        if effective_uid() == 0 {
            return; // Root has its own system contract, covered by the pure tests.
        }
        let Ok(xdg) = std::env::var("XDG_RUNTIME_DIR") else {
            return; // The no-XDG error is covered by the pure negative test.
        };

        assert_eq!(
            runtime_dir().unwrap(),
            PathBuf::from(xdg).join(RUNTIME_DIR_NAME)
        );
    }

    #[test]
    fn pid_paths_are_resolved_in_the_runtime_directory() {
        let _guard = lock_env();
        let runtime = tempfile::tempdir().unwrap();
        let _setting = EnvSetting::set(NESSION_RUNTIME_DIR_ENV, runtime.path());

        assert_eq!(
            server_pid_path().unwrap(),
            runtime.path().join("server.pid")
        );
        assert_eq!(agent_pid_path().unwrap(), runtime.path().join("agent.pid"));
    }

    #[test]
    fn legacy_pid_paths_stay_in_the_durable_component_directories() {
        let _guard = lock_env();
        let home = tempfile::tempdir().unwrap();
        let _setting = EnvSetting::set(NESSION_HOME_ENV, home.path());

        assert_eq!(
            legacy_server_pid_path().unwrap(),
            home.path().join("server").join("server.pid")
        );
        assert_eq!(
            legacy_agent_pid_path().unwrap(),
            home.path().join("agent").join("agent.pid")
        );
    }

    #[cfg(unix)]
    #[test]
    fn ensure_creates_an_owner_private_runtime_directory() {
        use std::os::unix::fs::MetadataExt;

        let _guard = lock_env();
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("nested").join("nession");
        let _setting = EnvSetting::set(NESSION_RUNTIME_DIR_ENV, &target);

        let created = ensure_runtime_dir().unwrap();

        assert_eq!(created, target);
        let metadata = std::fs::symlink_metadata(&created).unwrap();
        assert_eq!(
            metadata.mode() & 0o777,
            0o700,
            "runtime state must be private"
        );
        assert_eq!(
            metadata.uid(),
            effective_uid(),
            "runtime state must be user-owned"
        );
    }

    #[cfg(unix)]
    #[test]
    fn ensure_tightens_an_existing_runtime_directory() {
        use std::os::unix::fs::PermissionsExt;

        let _guard = lock_env();
        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let _setting = EnvSetting::set(NESSION_RUNTIME_DIR_ENV, root.path());

        ensure_runtime_dir().unwrap();

        let mode = std::fs::metadata(root.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o700,
            "an existing runtime directory must be tightened"
        );
    }

    #[cfg(unix)]
    #[test]
    fn ensure_rejects_a_symlinked_runtime_directory() {
        use std::os::unix::fs::PermissionsExt;

        let _guard = lock_env();
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let link = root.path().join("nession");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let _setting = EnvSetting::set(NESSION_RUNTIME_DIR_ENV, &link);

        let error = ensure_runtime_dir().expect_err("a symlink can redirect process state");
        assert!(
            error.to_string().contains("symlink"),
            "the error must name the unsafe shape: {error}"
        );
        assert_eq!(
            std::fs::metadata(&real).unwrap().permissions().mode() & 0o777,
            0o755,
            "the symlink target must not be treated as the runtime directory"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_group_writable_runtime_root_is_rejected() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o777)).unwrap();

        let error = validate_runtime_base(root.path()).expect_err("a shared root can be hijacked");
        assert!(
            error.to_string().contains("writable by group or other"),
            "the error must say why the root is unsafe: {error}"
        );
    }

    // --- Exact-path assertions for durable state (inlined from the old
    // `tests/paths_test.rs` split) ---

    fn expected_home() -> PathBuf {
        dirs::home_dir()
            .expect("home directory should be available")
            .join(".nession")
    }

    #[test]
    fn test_nession_home_exact() {
        let _guard = lock_env();
        assert_eq!(nession_home().unwrap(), expected_home());
    }

    #[test]
    fn test_server_dir_exact() {
        let _guard = lock_env();
        assert_eq!(server_dir().unwrap(), expected_home().join("server"));
    }

    #[test]
    fn test_agent_dir_exact() {
        let _guard = lock_env();
        assert_eq!(agent_dir().unwrap(), expected_home().join("agent"));
    }

    #[test]
    fn test_server_db_path_exact() {
        let _guard = lock_env();
        assert_eq!(
            server_db_path().unwrap(),
            expected_home().join("server").join("server.db")
        );
    }

    #[test]
    fn test_server_pid_path_exact() {
        let _guard = lock_env();
        let runtime = tempfile::tempdir().unwrap();
        let _setting = EnvSetting::set(NESSION_RUNTIME_DIR_ENV, runtime.path());

        assert_eq!(
            server_pid_path().unwrap(),
            runtime.path().join("server.pid")
        );
    }

    #[test]
    fn test_agent_pid_path_exact() {
        let _guard = lock_env();
        let runtime = tempfile::tempdir().unwrap();
        let _setting = EnvSetting::set(NESSION_RUNTIME_DIR_ENV, runtime.path());

        assert_eq!(agent_pid_path().unwrap(), runtime.path().join("agent.pid"));
    }

    #[test]
    fn test_ensure_component_dirs_creates_directories() {
        let _guard = lock_env();
        ensure_component_dirs().expect("ensure_component_dirs should succeed");
        assert!(server_dir().unwrap().exists());
        assert!(agent_dir().unwrap().exists());
    }
}
