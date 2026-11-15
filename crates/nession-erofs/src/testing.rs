//! Test-only executable-fixture installation.
//!
//! Every executable fixture in this crate installs through
//! [`install_via_a_child`]: writing the path a test execs is what produces the
//! Linux `ETXTBSY` flake recorded for #1026/#3504/#3612. The measured
//! rationale and its rejection of `rename` are on the fake-tmux copy in
//! `crates/nession-agent/src/test_support.rs`.

use std::path::Path;

/// Install `body` at `bin` with the file created by a **child** process.
///
/// `fork` copies the descriptor table, so while this process holds a write
/// descriptor on `bin`, every child it forks inherits a copy. `O_CLOEXEC`
/// drops that copy only once the child reaches its own `exec`; until then the
/// inode's write count is positive, and an `exec` of the same path fails with
/// `ETXTBSY` — `Text file busy (os error 26)`.
///
/// The body therefore goes to a path that is never exec'd, and a child `cp`
/// creates `bin`: this process's descriptor table then holds no write
/// descriptor on the executable, so a fork has nothing to copy. `chmod` does
/// not open the file, so it cannot reintroduce the window. `rename` is not
/// equivalent: it moves a directory entry, so the inode whose write count is
/// positive is still the one that gets exec'd.
pub(crate) fn install_via_a_child(bin: &Path, body: &str) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let staged = bin.with_extension("src");
    std::fs::write(&staged, body)?;
    let status = std::process::Command::new("cp")
        .arg(&staged)
        .arg(bin)
        .status();
    let _ = std::fs::remove_file(&staged);
    if !status?.success() {
        return Err(std::io::Error::other(
            "installing the executable fixture: cp exited with a failure status",
        ));
    }
    let mut permissions = std::fs::metadata(bin)?.permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(bin, permissions)
}
