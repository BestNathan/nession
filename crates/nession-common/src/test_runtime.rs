//! The process-scoped Test Runtime context (#4597).
//!
//! Every supported test entrypoint — `scripts/filtered-test.sh` / `just test` /
//! `./gates/run rust-test-*`, `scripts/check-coverage.sh`, the E2E and
//! Acceptance harnesses — creates **one** run-owned root and exports it to its
//! children:
//!
//! ```text
//! NSESSION_TEST_RUNTIME_DIR       absolute run root (0700, owned by this user)
//! NSESSION_TEST_RUNTIME_MANIFEST  absolute manifest path inside that root
//! ```
//!
//! The root owns every mutable resource the run may touch: `HOME`,
//! `NESSION_HOME`, `NESSION_RUNTIME_DIR`, `TMPDIR`, XDG/tool config roots and
//! the private tmux socket. See `scripts/test-runtime.sh`, the executable owner.
//!
//! A Cargo test/benchmark binary must resolve durable and process-lifecycle
//! paths inside that verified root. This module is the fail-closed boundary for
//! the two roots every other durable/runtime path derives from:
//! [`paths::nession_home`](crate::paths::nession_home) and
//! [`paths::runtime_dir`](crate::paths::runtime_dir). A bare `cargo test` that
//! never received a run root therefore fails with actionable instructions
//! instead of reading or writing the developer's live state; the tmux socket
//! has its own chokepoint guard (#4596) in `nession_agent::tmux::cmd`.
//!
//! Product binaries and `cargo run` output live directly under
//! `<target>/<profile>/`, not under `deps/`, so this boundary is never active
//! for shipped behavior. Subprocesses started by tests inherit the exported
//! run root; a test that spawns a product binary without it is a test bug the
//! inventory in `docs/engineering/test-runtime-isolation.md` classifies.
//!
//! Deliberately not used as authority: a name prefix, a PID, or the socket
//! server's self-report. The root must be a real directory owned by the current
//! effective uid with no group/other permission bits, must contain a
//! non-symlink manifest whose `root`/`uid`/`lifecycle` agree with it, and the
//! resolved path must canonicalize inside it.

use serde::Deserialize;
use std::io;
use std::path::{Component, Path, PathBuf};

/// Absolute run root exported by the test entrypoint.
pub const TEST_RUNTIME_DIR_ENV: &str = "NSESSION_TEST_RUNTIME_DIR";

/// Absolute manifest path inside [`TEST_RUNTIME_DIR_ENV`].
pub const TEST_RUNTIME_MANIFEST_ENV: &str = "NSESSION_TEST_RUNTIME_MANIFEST";

/// The only manifest schema this build understands.
pub const TEST_RUNTIME_SCHEMA_VERSION: u32 = 1;

/// The manifest `scripts/test-runtime.sh` writes at run-root creation.
///
/// One owner writes it and both the shell/JS harnesses and this module read it;
/// unknown future fields are tolerated so an additive schema change does not
/// force a lockstep upgrade.
#[derive(Debug, Clone, Deserialize)]
pub struct TestRuntimeManifest {
    pub schema_version: u32,
    pub run_id: String,
    pub owner_pid: u32,
    pub uid: u32,
    pub root: String,
    pub tmux_socket: String,
    pub lifecycle: String,
}

/// A verified Test Runtime root for this process.
#[derive(Debug, Clone)]
pub struct TestRuntimeContext {
    root: PathBuf,
    manifest: TestRuntimeManifest,
}

impl TestRuntimeContext {
    /// The canonical run root.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The parsed manifest that verified this root.
    pub fn manifest(&self) -> &TestRuntimeManifest {
        &self.manifest
    }
}

/// Whether this process is a Cargo test or benchmark executable.
///
/// The same predicate the tmux chokepoint uses: test/bench executables live
/// under `<target>/<profile>/deps/`, product binaries do not.
pub fn running_under_cargo_test_harness() -> bool {
    crate::tmux_socket::running_under_cargo_test_harness()
}

/// The verified run root for this process, when the harness installed one.
///
/// `Ok(None)` means this is not a test binary (production never consults a
/// test context), or a test binary was started without the capability. The
/// caller decides whether that is fatal; [`ensure_owned_path`] treats it as
/// fatal because a path resolution is about to leave the run's owned space.
pub fn installed() -> io::Result<Option<TestRuntimeContext>> {
    if !running_under_cargo_test_harness() {
        return Ok(None);
    }
    installed_for(
        std::env::var(TEST_RUNTIME_DIR_ENV).ok().as_deref(),
        std::env::var(TEST_RUNTIME_MANIFEST_ENV).ok().as_deref(),
        true,
        current_uid(),
    )
}

/// Refuse `path` unless it lives inside this run's verified root.
///
/// Inert for product processes. For a test binary it is the fail-closed
/// boundary in front of durable/runtime path resolution: no capability means
/// no production path, and a capability means only paths inside its root.
pub fn ensure_owned_path(kind: &str, path: &Path) -> io::Result<()> {
    if !running_under_cargo_test_harness() {
        return Ok(());
    }
    let Some(context) = installed()? else {
        return Err(missing_context(kind, path));
    };
    if path_inside(&context.root, path) {
        return Ok(());
    }
    Err(outside_context(kind, path, &context.root))
}

fn missing_context(kind: &str, path: &Path) -> io::Error {
    io::Error::other(format!(
        "refusing to resolve the production {kind} path {} in a Cargo test binary: this run \
         has no verified Test Runtime root (#4597). Run tests through scripts/filtered-test.sh, \
         `just test`, `./gates/run rust-test-*`, or the E2E/Acceptance harness \
         (scripts/test-runtime.sh creates the owned root), or point \
         {TEST_RUNTIME_DIR_ENV} and {TEST_RUNTIME_MANIFEST_ENV} at a root that harness created.",
        path.display()
    ))
}

fn outside_context(kind: &str, path: &Path, root: &Path) -> io::Error {
    io::Error::other(format!(
        "refusing to resolve the {kind} path {} in a Cargo test binary: it is outside this \
         run's verified Test Runtime root {} (#4597). Tests must resolve durable and \
         process-lifecycle state under the run root (HOME/NESSION_HOME/NESSION_RUNTIME_DIR), or \
         pass an explicit root to the owner constructor (for example \
         SessionMetadataStore::with_root) instead of a production or ad-hoc path.",
        path.display(),
        root.display()
    ))
}

#[allow(clippy::too_many_lines)]
fn installed_for(
    root_env: Option<&str>,
    manifest_env: Option<&str>,
    test_binary: bool,
    uid: u32,
) -> io::Result<Option<TestRuntimeContext>> {
    if !test_binary {
        return Ok(None);
    }
    let root_value = root_env.map(str::trim).filter(|value| !value.is_empty());
    let manifest_value = manifest_env
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let (Some(root_value), Some(manifest_value)) = (root_value, manifest_value) else {
        if root_value.is_some() || manifest_value.is_some() {
            return Err(io::Error::other(format!(
                "incomplete Test Runtime capability: both {TEST_RUNTIME_DIR_ENV} and \
                 {TEST_RUNTIME_MANIFEST_ENV} are required (#4597); re-run through \
                 scripts/filtered-test.sh, `just test`, or `./gates/run rust-test-*`"
            )));
        }
        return Ok(None);
    };

    let root_path = Path::new(root_value);
    if !root_path.is_absolute() {
        return Err(io::Error::other(format!(
            "{TEST_RUNTIME_DIR_ENV} must be an absolute path, but is '{root_value}' (#4597)"
        )));
    }
    let metadata = std::fs::symlink_metadata(root_path).map_err(|error| {
        io::Error::other(format!(
            "{TEST_RUNTIME_DIR_ENV} {} is not a usable run root: {error} (#4597)",
            root_path.display()
        ))
    })?;
    if metadata.file_type().is_symlink() {
        return Err(io::Error::other(format!(
            "{TEST_RUNTIME_DIR_ENV} {} is a symlink; the run root must be a real directory \
             (#4597)",
            root_path.display()
        )));
    }
    if !metadata.is_dir() {
        return Err(io::Error::other(format!(
            "{TEST_RUNTIME_DIR_ENV} {} is not a directory (#4597)",
            root_path.display()
        )));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        if metadata.uid() != uid {
            return Err(io::Error::other(format!(
                "{TEST_RUNTIME_DIR_ENV} {} is owned by uid {}, not the current user (uid {uid}) \
                 (#4597)",
                root_path.display(),
                metadata.uid()
            )));
        }
        if metadata.mode() & 0o077 != 0 {
            return Err(io::Error::other(format!(
                "{TEST_RUNTIME_DIR_ENV} {} is accessible by group or other users (mode {:o}); the \
                 run root must be 0700 (#4597)",
                root_path.display(),
                metadata.mode() & 0o777
            )));
        }
    }
    #[cfg(not(unix))]
    let _ = uid;
    let root = root_path.canonicalize().map_err(|error| {
        io::Error::other(format!(
            "cannot canonicalize the Test Runtime root {}: {error} (#4597)",
            root_path.display()
        ))
    })?;

    let manifest_path = Path::new(manifest_value);
    if !manifest_path.is_absolute() {
        return Err(io::Error::other(format!(
            "{TEST_RUNTIME_MANIFEST_ENV} must be an absolute path, but is '{manifest_value}' \
             (#4597)"
        )));
    }
    let manifest_metadata = std::fs::symlink_metadata(manifest_path).map_err(|error| {
        io::Error::other(format!(
            "{TEST_RUNTIME_MANIFEST_ENV} {} is not readable: {error} (#4597)",
            manifest_path.display()
        ))
    })?;
    if manifest_metadata.file_type().is_symlink() {
        return Err(io::Error::other(format!(
            "{TEST_RUNTIME_MANIFEST_ENV} {} is a symlink; the manifest must be a real file \
             inside the run root (#4597)",
            manifest_path.display()
        )));
    }
    let manifest_canonical = manifest_path.canonicalize().map_err(|error| {
        io::Error::other(format!(
            "cannot canonicalize the Test Runtime manifest {}: {error} (#4597)",
            manifest_path.display()
        ))
    })?;
    if !manifest_canonical.starts_with(&root) {
        return Err(io::Error::other(format!(
            "{TEST_RUNTIME_MANIFEST_ENV} {} is outside the run root {} (#4597)",
            manifest_canonical.display(),
            root.display()
        )));
    }

    let text = std::fs::read_to_string(&manifest_canonical).map_err(|error| {
        io::Error::other(format!(
            "cannot read the Test Runtime manifest {}: {error} (#4597)",
            manifest_canonical.display()
        ))
    })?;
    let manifest: TestRuntimeManifest = serde_json::from_str(&text).map_err(|error| {
        io::Error::other(format!(
            "invalid Test Runtime manifest {}: {error} (#4597)",
            manifest_canonical.display()
        ))
    })?;
    validate_manifest(&manifest, &root, uid, manifest_canonical.as_path())?;

    Ok(Some(TestRuntimeContext { root, manifest }))
}

fn validate_manifest(
    manifest: &TestRuntimeManifest,
    root: &Path,
    uid: u32,
    manifest_path: &Path,
) -> io::Result<()> {
    let invalid = |message: String| io::Error::other(format!("{message} (#4597)"));
    if manifest.schema_version != TEST_RUNTIME_SCHEMA_VERSION {
        return Err(invalid(format!(
            "Test Runtime manifest {} has schema_version {}, expected \
             {TEST_RUNTIME_SCHEMA_VERSION}",
            manifest_path.display(),
            manifest.schema_version
        )));
    }
    if manifest.run_id.trim().is_empty() {
        return Err(invalid(format!(
            "Test Runtime manifest {} has an empty run_id",
            manifest_path.display()
        )));
    }
    if manifest.lifecycle != "active" {
        return Err(invalid(format!(
            "Test Runtime manifest {} is '{}', not 'active'",
            manifest_path.display(),
            manifest.lifecycle
        )));
    }
    if manifest.uid != uid {
        return Err(invalid(format!(
            "Test Runtime manifest {} names uid {}, not the current user (uid {uid})",
            manifest_path.display(),
            manifest.uid
        )));
    }
    let manifest_root = Path::new(&manifest.root);
    if !manifest_root.is_absolute() || manifest_root.canonicalize().ok().as_deref() != Some(root) {
        return Err(invalid(format!(
            "Test Runtime manifest {} names root '{}', which does not match the verified root {}",
            manifest_path.display(),
            manifest.root,
            root.display()
        )));
    }
    let socket = Path::new(&manifest.tmux_socket);
    if !socket.is_absolute() || !path_inside(root, socket) {
        return Err(invalid(format!(
            "Test Runtime manifest {} names tmux socket '{}' outside the run root {}",
            manifest_path.display(),
            manifest.tmux_socket,
            root.display()
        )));
    }
    Ok(())
}

/// Whether `candidate` resolves inside `root`.
///
/// Lexical containment is checked first (so a path that needs no filesystem
/// access still resolves), then the longest existing ancestor is canonicalized
/// so a symlink inside the root cannot redirect the path outside it. The
/// candidate itself may not exist yet — a fresh home directory is created by
/// its owner after resolution.
fn path_inside(root: &Path, candidate: &Path) -> bool {
    let absolute = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(candidate),
            Err(_) => return false,
        }
    };
    let Some(normalized) = lexical_normalize(&absolute) else {
        return false;
    };
    if !normalized.starts_with(root) {
        return false;
    }
    let mut ancestor = normalized.as_path();
    loop {
        match std::fs::symlink_metadata(ancestor) {
            Ok(_) => {
                return ancestor
                    .canonicalize()
                    .map(|canonical| canonical.starts_with(root))
                    .unwrap_or(false);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let Some(parent) = ancestor.parent() else {
                    return false;
                };
                ancestor = parent;
            }
            Err(_) => return false,
        }
    }
}

/// Normalize `.`/`..` without touching the filesystem; `None` when a parent
/// traversal would escape the path's own root.
fn lexical_normalize(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(Path::new("/")),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
            }
            Component::Normal(name) => out.push(name),
        }
    }
    Some(out)
}

#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: `geteuid` has no preconditions and reads process-global state.
    unsafe { libc::geteuid() }
}

#[cfg(not(unix))]
fn current_uid() -> u32 {
    0
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn root_fixture() -> anyhow::Result<tempfile::TempDir> {
        let dir = tempfile::tempdir()?;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700))?;
        Ok(dir)
    }

    fn write_manifest(root: &Path, uid: u32, lifecycle: &str) -> std::io::Result<PathBuf> {
        let manifest = root.join("manifest.json");
        let socket = root.join("tmux.sock");
        let text = format!(
            "{{\"schema_version\":1,\"run_id\":\"probe-run\",\"owner_pid\":{},\
             \"uid\":{uid},\"root\":\"{}\",\"tmux_socket\":\"{}\",\
             \"lifecycle\":\"{lifecycle}\"}}",
            std::process::id(),
            root.display(),
            socket.display()
        );
        std::fs::write(&manifest, text)?;
        Ok(manifest)
    }

    #[test]
    fn a_verified_root_is_accepted() {
        let dir = root_fixture().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let manifest = write_manifest(&root, current_uid(), "active").unwrap();
        let context = installed_for(
            Some(root.to_str().unwrap()),
            Some(manifest.to_str().unwrap()),
            true,
            current_uid(),
        )
        .unwrap()
        .expect("a verified root");
        assert_eq!(context.root(), root);
        assert_eq!(context.manifest().run_id, "probe-run");
    }

    #[test]
    fn a_product_process_never_consults_a_test_context() {
        let dir = root_fixture().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let manifest = write_manifest(&root, current_uid(), "active").unwrap();
        assert!(installed_for(
            Some(root.to_str().unwrap()),
            Some(manifest.to_str().unwrap()),
            false,
            current_uid(),
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn a_test_binary_without_a_capability_is_refused() {
        assert!(installed_for(None, None, true, current_uid())
            .unwrap()
            .is_none());
        assert!(installed_for(Some(""), Some(""), true, current_uid())
            .unwrap()
            .is_none());
    }

    #[test]
    fn an_incomplete_capability_is_refused() {
        let dir = root_fixture().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let manifest = write_manifest(&root, current_uid(), "active").unwrap();
        assert!(installed_for(Some(root.to_str().unwrap()), None, true, current_uid()).is_err());
        assert!(
            installed_for(None, Some(manifest.to_str().unwrap()), true, current_uid()).is_err()
        );
    }

    #[test]
    fn a_relative_root_is_refused() {
        assert!(installed_for(
            Some("relative/root"),
            Some("manifest.json"),
            true,
            current_uid()
        )
        .is_err());
    }

    #[test]
    fn a_symlinked_root_is_refused() {
        let dir = root_fixture().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let manifest = write_manifest(&real, current_uid(), "active").unwrap();
        let link = dir.path().join("link");
        symlink(&real, &link).unwrap();
        let error = installed_for(
            Some(link.to_str().unwrap()),
            Some(manifest.to_str().unwrap()),
            true,
            current_uid(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("symlink"), "{error}");
    }

    #[test]
    fn a_foreign_uid_is_refused() {
        let dir = root_fixture().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let manifest = write_manifest(&root, current_uid(), "active").unwrap();
        let error = installed_for(
            Some(root.to_str().unwrap()),
            Some(manifest.to_str().unwrap()),
            true,
            current_uid() + 1,
        )
        .unwrap_err();
        assert!(error.to_string().contains("owned by uid"), "{error}");
    }

    #[test]
    fn a_manifest_outside_the_root_is_refused() {
        let outside_dir = root_fixture().unwrap();
        let dir = root_fixture().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let outside = outside_dir.path().join("outside.json");
        std::fs::write(&outside, "{}").unwrap();
        let error = installed_for(
            Some(root.to_str().unwrap()),
            Some(outside.to_str().unwrap()),
            true,
            current_uid(),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("outside the run root"),
            "{error}"
        );
    }

    #[test]
    fn a_manifest_naming_another_root_is_refused() {
        let dir = root_fixture().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let manifest = root.join("manifest.json");
        std::fs::write(
            &manifest,
            "{\"schema_version\":1,\"run_id\":\"probe\",\"owner_pid\":1,\"uid\":U,\
             \"root\":\"/tmp/other\",\"tmux_socket\":\"/tmp/other/tmux.sock\",\
             \"lifecycle\":\"active\"}"
                .replace('U', &current_uid().to_string()),
        )
        .unwrap();
        let error = installed_for(
            Some(root.to_str().unwrap()),
            Some(manifest.to_str().unwrap()),
            true,
            current_uid(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("does not match"), "{error}");
    }

    #[test]
    fn a_finished_manifest_is_refused() {
        let dir = root_fixture().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let manifest = write_manifest(&root, current_uid(), "finished").unwrap();
        let error = installed_for(
            Some(root.to_str().unwrap()),
            Some(manifest.to_str().unwrap()),
            true,
            current_uid(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("not 'active'"), "{error}");
    }

    #[test]
    fn a_path_inside_the_verified_root_is_owned() {
        let dir = root_fixture().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let owned = root.join("home").join(".nession");
        assert!(path_inside(&root, &owned));
        assert!(path_inside(&root, &root));
    }

    #[test]
    fn a_path_outside_the_verified_root_is_not_owned() {
        let dir = root_fixture().unwrap();
        let root = dir.path().canonicalize().unwrap();
        assert!(!path_inside(&root, Path::new("/tmp/nession-501/tmux.sock")));
        assert!(!path_inside(&root, &root.join("..").join("escape")));
    }

    #[test]
    fn a_symlink_inside_the_root_cannot_escape_it() {
        let outside_dir = root_fixture().unwrap();
        let dir = root_fixture().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let link = root.join("escape");
        symlink(outside_dir.path(), &link).unwrap();
        assert!(!path_inside(&root, &link.join("state")));
    }

    #[test]
    fn this_test_process_has_a_verified_runtime_context() {
        // SC-01: the harness must install the context before any test code
        // resolves a durable/runtime path. This test binary is run by that
        // harness, so a missing or invalid capability is a harness defect.
        let context = installed()
            .expect("the Test Runtime capability must be valid")
            .expect("the private-socket harness must export the run root");
        assert!(context.root().is_dir());
        assert_eq!(context.manifest().lifecycle, "active");
    }
}
