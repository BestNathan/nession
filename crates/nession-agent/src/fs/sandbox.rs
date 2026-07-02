use anyhow::{Context, Result};
use std::path::{Component, Path, PathBuf};

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

        // Early detection of `..` escapes via logical path normalization.
        // This catches escapes even when intermediate paths don't exist
        // on the filesystem (which would otherwise fail at canonicalization
        // before reaching the permission check).
        let normalized = normalize_path(&combined);
        if !normalized.starts_with(&self.root) {
            anyhow::bail!("permission_denied: path outside sandbox root");
        }

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

/// Resolve `.` and `..` path components without touching the filesystem.
///
/// This provides a logical (not canonical) normalization useful for
/// detecting directory traversal escape attempts before filesystem
/// operations are attempted.
fn normalize_path(path: &Path) -> PathBuf {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                components.pop();
            }
            Component::CurDir => {}
            c => components.push(c.as_os_str()),
        }
    }
    let mut result = PathBuf::new();
    for c in components {
        result.push(c);
    }
    result
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
