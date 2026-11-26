//! Which files in a log directory are the component's history.
//!
//! Runtime history is selected by the writer's own naming contract
//! (`nession_common::logging::parse_runtime_log_file_name`), never by a glob:
//! unrelated files, symlinks, directories and another component's files are
//! excluded. Historical rotation's dated files are ordered oldest first; an
//! undated (`never` rotation) file is placed last because the writer may still
//! be appending to it (#4600 SC-02/SC-03).

use std::io;
use std::path::{Path, PathBuf};

use nession_common::logging::{parse_runtime_log_file_name, LogComponent, LogRotation};

/// Runtime log files for `component` under `dir`, oldest first.
///
/// A missing directory means "no history yet" (`Ok(empty)`). An unreadable
/// directory or entry is an error: absence and a permission failure must stay
/// distinguishable.
pub fn runtime_log_files(dir: &Path, component: LogComponent) -> io::Result<Vec<PathBuf>> {
    if !ensure_real_directory(dir)? {
        return Ok(Vec::new());
    }
    let entries = std::fs::read_dir(dir)?;
    let mut files: Vec<(SortKey, PathBuf)> = Vec::new();
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(parsed) = parse_runtime_log_file_name(component.log_prefix(), &name) else {
            continue;
        };
        let metadata = std::fs::symlink_metadata(entry.path())?;
        if !metadata.file_type().is_file() {
            continue;
        }
        files.push((SortKey::new(parsed.rotation, parsed.period), entry.path()));
    }
    files.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    Ok(files.into_iter().map(|(_, path)| path).collect())
}

/// Startup diagnostics files under `dir`, oldest first.
pub fn startup_log_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    if !ensure_real_directory(dir)? {
        return Ok(Vec::new());
    }
    nession_common::startup_log::startup_log_files(dir)
}

/// Managed-service capture files that exist, in read order.
///
/// Service captures are raw stdout/stderr streams; the older rotated file
/// (`.1`) precedes the current one. Only the exact names this CLI generates
/// participate.
pub fn service_capture_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    if !ensure_real_directory(dir)? {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for name in [
        format!("{}.1", nession_common::logging::SERVICE_CAPTURE_STDOUT_FILE),
        format!("{}.1", nession_common::logging::SERVICE_CAPTURE_STDERR_FILE),
        nession_common::logging::SERVICE_CAPTURE_STDOUT_FILE.to_string(),
        nession_common::logging::SERVICE_CAPTURE_STDERR_FILE.to_string(),
    ] {
        let path = dir.join(&name);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_file() => files.push(path),
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(files)
}

/// Whether `dir` is a real directory (missing is `Ok(false)`).
///
/// A symlinked log directory is a path escape: the read would follow it
/// outside the selected home. It is refused instead of trusted (#4600 SC-02).
fn ensure_real_directory(dir: &Path) -> io::Result<bool> {
    match std::fs::symlink_metadata(dir) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
        Ok(metadata) if metadata.file_type().is_symlink() => Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "log directory {} is a symlink; refusing to follow it outside the selected home",
                dir.display()
            ),
        )),
        Ok(metadata) if metadata.is_dir() => Ok(true),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("log directory {} is not a directory", dir.display()),
        )),
    }
}

/// Sort by rotation period, then undated files last.
#[derive(Debug, Clone, PartialEq, Eq)]
struct SortKey {
    /// Dated files sort by their canonical period string; `None` sorts last.
    period: Option<String>,
    rotation: u8,
}

impl Ord for SortKey {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match (&self.period, &other.period) {
            (Some(left), Some(right)) => left.cmp(right),
            // An undated (`never`) file may still be the writer's active
            // file, so it sorts after every dated file.
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
        .then_with(|| self.rotation.cmp(&other.rotation))
    }
}

impl PartialOrd for SortKey {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl SortKey {
    fn new(rotation: LogRotation, period: Option<String>) -> Self {
        Self {
            period,
            rotation: match rotation {
                LogRotation::Hourly => 0,
                LogRotation::Daily => 1,
                LogRotation::Never => 2,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nession_common::logging::{AGENT_LOG_PREFIX, SERVER_LOG_PREFIX};

    fn touch(dir: &Path, name: &str) {
        std::fs::write(dir.join(name), b"line\n").unwrap();
    }

    #[test]
    fn the_writers_names_are_ordered_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "nession-agent.2026-11-26");
        touch(dir.path(), "nession-agent.2026-11-24");
        touch(dir.path(), "nession-agent.2026-11-25-01");
        touch(dir.path(), "nession-agent.2026-11-25-00");

        let files = runtime_log_files(dir.path(), LogComponent::Agent).unwrap();
        let names: Vec<String> = files
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            vec![
                "nession-agent.2026-11-24".to_string(),
                "nession-agent.2026-11-25-00".to_string(),
                "nession-agent.2026-11-25-01".to_string(),
                "nession-agent.2026-11-26".to_string(),
            ]
        );
    }

    #[test]
    fn an_undated_never_file_is_last() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "nession-agent.2026-11-26");
        touch(dir.path(), AGENT_LOG_PREFIX);
        let files = runtime_log_files(dir.path(), LogComponent::Agent).unwrap();
        assert_eq!(files.last().unwrap().file_name().unwrap(), AGENT_LOG_PREFIX);
    }

    #[test]
    fn unrelated_files_and_symlinks_are_excluded() {
        let dir = tempfile::tempdir().unwrap();
        touch(dir.path(), "nession-agent.2026-11-26");
        touch(dir.path(), "nession-agent.out");
        touch(dir.path(), "nession-agent.1");
        touch(dir.path(), "notes.txt");
        touch(dir.path(), SERVER_LOG_PREFIX);
        std::fs::create_dir(dir.path().join("nession-agent.2026-11-27")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            dir.path().join("nession-agent.2026-11-26"),
            dir.path().join("nession-agent.2026-11-28"),
        )
        .unwrap();

        let files = runtime_log_files(dir.path(), LogComponent::Agent).unwrap();
        let names: Vec<String> = files
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["nession-agent.2026-11-26".to_string()]);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_log_directory_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::write(real.join("nession-agent"), b"line\n").unwrap();
        let link = root.path().join("linked");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let error = runtime_log_files(&link, LogComponent::Agent)
            .expect_err("a symlinked log directory is a path escape");
        assert!(error.to_string().contains("symlink"), "{error}");
    }

    #[test]
    fn a_missing_directory_is_empty_history() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("never-created");
        assert!(runtime_log_files(&missing, LogComponent::Agent)
            .unwrap()
            .is_empty());
    }
}
