//! Small bounded host helpers shared by the backends.

use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

/// Read a file and trim the trailing newline.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn read_trimmed(path: &Path) -> io::Result<String> {
    Ok(std::fs::read_to_string(path)?.trim().to_string())
}

/// Write a file, replacing it atomically where a reader may observe it.
pub fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "path has no file name"))?;
    let temporary = parent.join(format!(".{file_name}.tmp-{}", std::process::id()));
    std::fs::write(&temporary, contents)?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}

/// Poll `condition` until it is true or the deadline passes.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn wait_until(
    timeout: Duration,
    poll_interval: Duration,
    mut condition: impl FnMut() -> bool,
) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if condition() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(poll_interval);
    }
}

/// Walk the parent chain from `pid` and return true when `ancestor` is visited.
#[cfg(target_os = "linux")]
pub fn is_descendant_of(pid: u32, ancestor: u32) -> bool {
    let mut current = pid;
    for _ in 0..64 {
        if current == ancestor {
            return true;
        }
        if current <= 1 {
            return false;
        }
        let Ok(status) = std::fs::read_to_string(format!("/proc/{current}/status")) else {
            return false;
        };
        let Some(parent) = status
            .lines()
            .find_map(|line| line.strip_prefix("PPid:"))
            .and_then(|value| value.trim().parse::<u32>().ok())
        else {
            return false;
        };
        if parent == current {
            return false;
        }
        current = parent;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_replaces_and_leaves_no_temporary() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("record.json");
        write_atomic(&path, b"one").expect("first write");
        write_atomic(&path, b"two").expect("second write");
        assert_eq!(std::fs::read(&path).expect("read"), b"two");
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with('.'))
            .collect();
        assert!(leftovers.is_empty(), "temporary file left behind");
    }

    #[test]
    fn wait_until_returns_after_the_condition() {
        let start = Instant::now();
        assert!(wait_until(
            Duration::from_secs(1),
            Duration::from_millis(5),
            || { start.elapsed() >= Duration::from_millis(20) }
        ));
        assert!(!wait_until(
            Duration::from_millis(10),
            Duration::from_millis(5),
            || false
        ));
    }
}
