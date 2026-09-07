//! Resolution and validation of nession's own tmux socket path.
//!
//! nession addresses tmux exclusively through an explicit `-S <absolute path>`,
//! so its sessions live on a server of its own and can never be listed — or
//! killed — together with the user's hand-made tmux sessions. Nothing here ever
//! falls back to tmux's default socket: a socket that cannot be prepared is a
//! startup error, because falling back is the failure this module exists to
//! remove.
//!
//! ## Why not `TMUX_TMPDIR`
//!
//! `TMUX_TMPDIR` was the previous mechanism and it fails silently (measured in
//! #574): tmux ignores it entirely once `$TMUX` is set — which is always true
//! when anything runs from inside a tmux session — and it also ignores it when
//! the directory does not exist. In both cases tmux exits 0 having used the
//! default socket. `-S` is immune to `$TMUX` (measured: a probe session created
//! with `-S` from inside a live tmux session landed on the `-S` path).
//!
//! ## Resolution order
//!
//! 1. the agent's `tmux_socket_path` config key, when set
//! 2. `$NESSION_TMUX_SOCKET` — how the e2e and Rust test runners give each run
//!    a private socket
//! 3. [`default_socket_path`] — `<temp dir>/nession-<uid>/tmux.sock`

use std::io;
use std::path::{Path, PathBuf};

/// Environment variable that overrides the tmux socket path.
///
/// Set per run by `scripts/filtered-test.sh`, `scripts/check-coverage.sh` and
/// the Playwright config, so concurrent runs cannot see each other's sessions.
pub const NESSION_TMUX_SOCKET_ENV: &str = "NESSION_TMUX_SOCKET";

/// Maximum usable length of a unix socket path.
///
/// `sockaddr_un.sun_path` is 104 bytes on macOS and 108 on Linux; the smaller
/// limit is applied on both so a path that works on one works on the other.
/// One byte is reserved for the NUL terminator. Exceeding it makes tmux fail
/// with "File name too long" (measured), which is why the length is checked up
/// front instead.
pub const MAX_SOCKET_PATH_LEN: usize = 103;

/// Default socket path: `/tmp/nession-<uid>/tmux.sock`.
///
/// Deliberately mirrors tmux's own `/tmp/tmux-<uid>/default` convention:
///
/// - **always writable** — unlike `$NESSION_HOME`, which in this project's k8s
///   deployment is an NFS mount (`192.168.2.105:/mnt/share/k8s/production`),
///   where binding a unix socket is not reliable
/// - **short** — 26–28 bytes, far below [`MAX_SOCKET_PATH_LEN`]
/// - **per user** — the uid segment keeps two users on one host apart, since
///   the directory is created 0700
/// - **ephemeral** — a socket is not state worth persisting; a restarted pod
///   or host reboot leaves nothing behind to reconcile
///
/// `/tmp` is hardcoded rather than taken from [`std::env::temp_dir`], which
/// honours `$TMPDIR`. On macOS `$TMPDIR` is a per-user path like
/// `/var/folders/<hash>/T/` and its value depends on how the process was
/// started — a shell and a LaunchAgent can see different ones. The agent and the
/// `nession` CLI must resolve the *same* socket or the CLI reports an empty
/// session list, so the default cannot depend on inherited environment. tmux
/// hardcodes `/tmp` for the same reason.
pub fn default_socket_path() -> PathBuf {
    PathBuf::from("/tmp")
        .join(format!("nession-{}", current_uid()))
        .join("tmux.sock")
}

/// Real uid of this process.
///
/// `libc::getuid()` cannot fail and touches no memory, which is what makes the
/// `unsafe` block sound here.
fn current_uid() -> u32 {
    unsafe { libc::getuid() }
}

/// Resolve the socket path from an optional configured value, the environment,
/// then the default. See the module docs for the ordering rationale.
pub fn resolve_socket_path(configured: Option<&str>) -> PathBuf {
    if let Some(path) = configured.map(str::trim).filter(|p| !p.is_empty()) {
        return PathBuf::from(path);
    }
    if let Ok(path) = std::env::var(NESSION_TMUX_SOCKET_ENV) {
        let path = path.trim();
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    default_socket_path()
}

/// Validate `path` and create its parent directory, 0700.
///
/// tmux does **not** create the socket's parent directory (measured: it fails
/// with "error creating <path> (No such file or directory)"), so nession must.
/// Returns an error rather than falling back to any other location.
pub fn prepare_socket_dir(path: &Path) -> io::Result<()> {
    check_socket_path_len(path)?;

    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "tmux socket path has no parent directory: {}",
                path.display()
            ),
        )
    })?;

    std::fs::create_dir_all(parent).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!(
                "failed to create tmux socket directory {}: {e} \
                 (set tmux_socket_path in the agent config or ${NESSION_TMUX_SOCKET_ENV} \
                 to a writable location)",
                parent.display()
            ),
        )
    })?;

    // 0700: the socket grants full control of every session on this tmux
    // server, so no other user may reach it.
    restrict_dir_permissions(parent)?;

    Ok(())
}

/// Reject a path that a unix socket cannot be bound to, naming the actual
/// length so the fix is obvious.
pub fn check_socket_path_len(path: &Path) -> io::Result<()> {
    let len = path.as_os_str().as_encoded_bytes().len();
    if len > MAX_SOCKET_PATH_LEN {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "tmux socket path is {len} bytes, over the {MAX_SOCKET_PATH_LEN}-byte unix \
                 socket limit: {} — choose a shorter path",
                path.display()
            ),
        ));
    }
    Ok(())
}

/// Set 0700 on the socket directory.
fn restrict_dir_permissions(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(dir)?.permissions();
    perms.set_mode(0o700);
    std::fs::set_permissions(dir, perms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Serialise the tests that mutate `NESSION_TMUX_SOCKET`. `set_var` /
    /// `remove_var` are process-global and Rust runs tests in parallel, so
    /// without this one test's mutation lands in the middle of another's read.
    static ENV_MUTEX: Mutex<()> = Mutex::new(());

    /// Saved value of `NESSION_TMUX_SOCKET`, put back when the test is done.
    ///
    /// The test runner exports the variable to give the run its own socket
    /// (`scripts/tmux-run-socket.sh`); a test that clobbered it and walked away
    /// would redirect every later tmux call in this process.
    struct EnvRestore(Option<String>);

    impl EnvRestore {
        fn capture() -> Self {
            Self(std::env::var(NESSION_TMUX_SOCKET_ENV).ok())
        }

        fn apply(self) {
            match self.0 {
                Some(ref value) => std::env::set_var(NESSION_TMUX_SOCKET_ENV, value),
                None => std::env::remove_var(NESSION_TMUX_SOCKET_ENV),
            }
        }
    }

    #[test]
    fn default_socket_path_is_under_slash_tmp_with_uid() {
        // Hardcoded /tmp, not $TMPDIR: the agent and the CLI have to agree on
        // this path without depending on inherited environment.
        let path = default_socket_path();
        assert_eq!(
            path,
            PathBuf::from(format!("/tmp/nession-{}/tmux.sock", current_uid()))
        );
    }

    #[test]
    fn default_socket_path_ignores_tmpdir() {
        let _guard = ENV_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let original = std::env::var("TMPDIR").ok();
        std::env::set_var("TMPDIR", "/tmp/nession-some-other-tmpdir");
        let path = default_socket_path();
        match original {
            Some(ref value) => std::env::set_var("TMPDIR", value),
            None => std::env::remove_var("TMPDIR"),
        }
        // Compared as a string: Path::starts_with matches whole components, so
        // it would reject "/tmp/nession-501" against a "/tmp/nession-" prefix.
        let rendered = path.to_string_lossy();
        assert!(
            rendered.starts_with("/tmp/nession-"),
            "TMPDIR must not move the default socket: {rendered}"
        );
        assert!(!rendered.contains("some-other-tmpdir"));
    }

    #[test]
    fn default_socket_path_fits_the_unix_limit() {
        // The whole point of picking a temp-dir path: it stays well short of
        // sun_path even on macOS, where temp_dir() is a long per-user path.
        assert!(check_socket_path_len(&default_socket_path()).is_ok());
    }

    #[test]
    fn configured_path_wins_over_env_and_default() {
        // No env manipulation: a configured value must short-circuit before the
        // env var is even consulted, which is exactly what this asserts.
        let resolved = resolve_socket_path(Some("/tmp/nession-configured/tmux.sock"));
        assert_eq!(resolved, PathBuf::from("/tmp/nession-configured/tmux.sock"));
    }

    #[test]
    fn blank_configured_path_matches_an_absent_one() {
        // A key present but empty in TOML must behave as "not set" — never as a
        // socket named "" in the process CWD. Compared against `None` rather
        // than against the default, because the test runner exports
        // NESSION_TMUX_SOCKET and `None` legitimately resolves to that.
        assert_eq!(resolve_socket_path(Some("   ")), resolve_socket_path(None));
        assert_eq!(resolve_socket_path(Some("")), resolve_socket_path(None));
    }

    #[test]
    fn env_var_is_used_when_config_is_absent() {
        let _guard = ENV_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let restore = EnvRestore::capture();
        std::env::set_var(NESSION_TMUX_SOCKET_ENV, "/tmp/nession-from-env/tmux.sock");
        assert_eq!(
            resolve_socket_path(None),
            PathBuf::from("/tmp/nession-from-env/tmux.sock")
        );
        // Config still outranks it.
        assert_eq!(
            resolve_socket_path(Some("/tmp/nession-from-config/tmux.sock")),
            PathBuf::from("/tmp/nession-from-config/tmux.sock")
        );
        restore.apply();
    }

    #[test]
    fn default_is_used_when_neither_config_nor_env_is_set() {
        let _guard = ENV_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let restore = EnvRestore::capture();
        std::env::remove_var(NESSION_TMUX_SOCKET_ENV);
        assert_eq!(resolve_socket_path(None), default_socket_path());
        restore.apply();
    }

    #[test]
    fn blank_env_var_falls_through_to_the_default() {
        let _guard = ENV_MUTEX
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let restore = EnvRestore::capture();
        std::env::set_var(NESSION_TMUX_SOCKET_ENV, "  ");
        assert_eq!(resolve_socket_path(None), default_socket_path());
        restore.apply();
    }

    #[test]
    fn resolve_trims_the_configured_path() {
        let resolved = resolve_socket_path(Some("  /tmp/nession-trim/tmux.sock  "));
        assert_eq!(resolved, PathBuf::from("/tmp/nession-trim/tmux.sock"));
    }

    #[test]
    fn over_long_path_is_rejected_with_its_length() {
        let long = PathBuf::from(format!("/tmp/{}/tmux.sock", "a".repeat(120)));
        let err = check_socket_path_len(&long).expect_err("over-long path must be rejected");
        let msg = err.to_string();
        assert!(
            msg.contains("over the"),
            "message should name the limit: {msg}"
        );
        assert!(
            msg.contains(&long.as_os_str().as_encoded_bytes().len().to_string()),
            "message should name the actual length: {msg}"
        );
    }

    #[test]
    fn path_at_the_limit_is_accepted() {
        let base = "/tmp/";
        let path = PathBuf::from(format!(
            "{base}{}",
            "a".repeat(MAX_SOCKET_PATH_LEN - base.len())
        ));
        assert_eq!(
            path.as_os_str().as_encoded_bytes().len(),
            MAX_SOCKET_PATH_LEN
        );
        assert!(check_socket_path_len(&path).is_ok());
    }

    #[test]
    fn prepare_creates_the_parent_directory_0700() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("nested").join("tmux.sock");
        prepare_socket_dir(&socket).expect("prepare");

        let parent = socket.parent().expect("parent");
        assert!(parent.is_dir(), "parent directory should have been created");
        let mode = std::fs::metadata(parent)
            .expect("metadata")
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o777,
            0o700,
            "socket dir must not be reachable by other users"
        );
    }

    #[test]
    fn prepare_is_idempotent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("tmux.sock");
        prepare_socket_dir(&socket).expect("first prepare");
        prepare_socket_dir(&socket).expect("second prepare should be a no-op");
    }

    #[test]
    fn prepare_rejects_an_over_long_path_before_touching_the_filesystem() {
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("b".repeat(200)).join("tmux.sock");
        let err = prepare_socket_dir(&socket).expect_err("over-long path must fail");
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(
            !socket.parent().map(Path::exists).unwrap_or(false),
            "no directory should be created for a rejected path"
        );
    }

    #[test]
    fn prepare_error_names_the_offending_directory() {
        // /dev/null is not a directory, so create_dir_all under it fails.
        let socket = Path::new("/dev/null/nession/tmux.sock");
        let err = prepare_socket_dir(socket).expect_err("must fail under /dev/null");
        let msg = err.to_string();
        assert!(
            msg.contains("/dev/null/nession"),
            "message should name the directory it could not create: {msg}"
        );
        assert!(
            msg.contains(NESSION_TMUX_SOCKET_ENV),
            "message should point at the override: {msg}"
        );
    }
}
