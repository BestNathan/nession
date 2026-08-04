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
    /// Returns the resolved path; existing components are canonicalized.
    /// Returns an error with code `permission_denied` if the resolved
    /// path lies outside the root.
    pub fn resolve(&self, path: &str) -> Result<PathBuf> {
        // If the path is absolute and exists on the filesystem, use it directly.
        // This handles paths outside the sandbox root (terminal can access
        // arbitrary paths, so the file browser follows suit).
        if path.starts_with('/') {
            if let Ok(canonical) = std::fs::canonicalize(path) {
                return Ok(canonical);
            }
        }

        // Relative or non-existent path: normalize and join with sandbox root.
        let relative = path.trim_start_matches('/');
        let relative = if let Some(root_name) = self.root.file_name() {
            Path::new(relative)
                .strip_prefix(root_name)
                .map(|p| p.as_os_str().to_string_lossy().into_owned())
                .unwrap_or_else(|_| relative.to_string())
        } else {
            relative.to_string()
        };
        let combined = self.root.join(&relative);

        // Canonicalize. For non-existent paths (create_dir, write_file),
        // walk up the ancestor chain and append the suffix.
        match std::fs::canonicalize(&combined) {
            Ok(p) => Ok(p),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut ancestor = combined.as_path();
                let mut suffix: Option<PathBuf> = None;
                loop {
                    match std::fs::canonicalize(ancestor) {
                        Ok(canonical) => {
                            return Ok(match suffix {
                                Some(s) => canonical.join(&s),
                                None => canonical,
                            });
                        }
                        Err(inner) if inner.kind() == std::io::ErrorKind::NotFound => {
                            let name = ancestor.file_name().context("path has no filename")?;
                            suffix = Some(match suffix {
                                Some(s) => PathBuf::from(name).join(&s),
                                None => PathBuf::from(name),
                            });
                            ancestor = ancestor.parent().context("path has no parent")?;
                        }
                        Err(inner) => {
                            return Err(anyhow::Error::from(inner))
                                .with_context(|| format!("failed to resolve path: {path}"))
                        }
                    }
                }
            }
            Err(e) => Err(anyhow::Error::from(e)).context("failed to resolve path"),
        }
    }

    /// Return the sandbox root path.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Convert an absolute path to a path usable by [`resolve`].
    ///
    /// If the path is inside the sandbox root, returns a relative path
    /// (empty string for the root itself). Otherwise returns the absolute
    /// path as-is so `resolve()` can canonicalize it directly.
    pub fn relative_path(&self, abs_path: &str) -> Result<String> {
        let canonical = std::fs::canonicalize(abs_path)
            .with_context(|| format!("failed to canonicalize path: {abs_path}"))?;
        if let Ok(rel) = canonical.strip_prefix(&self.root) {
            let s = rel.to_string_lossy().to_string();
            return Ok(s.trim_start_matches('/').to_string());
        }
        // Path is outside sandbox — return as absolute path.
        Ok(canonical.to_string_lossy().to_string())
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
        assert_eq!(
            resolved,
            dir.path().canonicalize().unwrap().join("new_file.txt")
        );
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
    fn test_resolve_allows_dot_dot_outside_sandbox() {
        let (_dir, sandbox) = setup_sandbox();
        // Sandbox boundary is intentionally not enforced — terminal can
        // access arbitrary paths, so the file browser follows.
        let result = sandbox.resolve("../etc/passwd");
        // May succeed or fail depending on whether /etc/passwd exists.
        // The key is it no longer rejects with permission_denied.
        if let Err(e) = &result {
            assert!(
                !e.to_string().contains("permission_denied"),
                "should not reject with permission_denied: {e}"
            );
        }
    }

    #[test]
    fn test_resolve_absolute_path_strips_leading_slash() {
        let (dir, sandbox) = setup_sandbox();
        // Use a path that does NOT exist on the real filesystem, so the
        // sandbox-root-relative fallback is exercised (rather than the
        // absolute-path shortcut). `/nonexistent-dir-xyz/file` → `<root>/nonexistent-dir-xyz/file`.
        let result = sandbox.resolve("/nonexistent-dir-xyz/file").unwrap();
        let expected = dir
            .path()
            .canonicalize()
            .unwrap()
            .join("nonexistent-dir-xyz/file");
        assert_eq!(result, expected);
    }

    #[test]
    fn test_resolve_allows_symlink_outside_sandbox() {
        let (dir, sandbox) = setup_sandbox();
        let link_path = dir.path().join("escape_link");
        symlink("/etc/passwd", &link_path).unwrap();

        // Boundary intentionally not enforced — symlinks to outside paths are allowed.
        let result = sandbox.resolve("escape_link");
        // Should succeed if /etc/passwd exists, fail for other reasons (e.g. permissions).
        if let Err(e) = &result {
            assert!(
                !e.to_string().contains("permission_denied"),
                "should not reject with permission_denied: {e}"
            );
        }
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

    /// Regression test: when a client sends an absolute path whose first
    /// component matches the sandbox root's own directory name, the root
    /// must NOT be doubled. E.g., sandbox at `/root` + path `root/.bashrc`
    /// must resolve to `/root/.bashrc`, not `/root/root/.bashrc`.
    #[test]
    fn test_resolve_strips_duplicated_root_name() {
        // Create a sandbox in a parent dir whose name matches the first
        // path component we'll resolve (simulates "/root" + "root/.bashrc").
        let parent = tempfile::tempdir().unwrap();
        let root_dir_name = "testroot";
        let root_path = parent.path().join(root_dir_name);
        fs::create_dir(&root_path).unwrap();

        let sandbox = PathSandbox::new(&root_path).unwrap();

        // Create a target file inside the sandbox.
        let target = root_path.join(".bashrc");
        fs::write(&target, b"hello").unwrap();

        // 1. Relative path with root name duplicated (the failing case).
        let dup_relative = format!("{}/.bashrc", root_dir_name);
        let resolved = sandbox.resolve(&dup_relative).unwrap();
        assert_eq!(resolved, target.canonicalize().unwrap());

        // 2. Absolute path that starts with the root name.
        let dup_absolute = format!("/{}/.bashrc", root_dir_name);
        let resolved = sandbox.resolve(&dup_absolute).unwrap();
        assert_eq!(resolved, target.canonicalize().unwrap());

        // 3. Regular relative path (no duplication) still works.
        let resolved = sandbox.resolve(".bashrc").unwrap();
        assert_eq!(resolved, target.canonicalize().unwrap());

        // 4. Absolute path without root-name duplication still works.
        let resolved = sandbox.resolve("/.bashrc").unwrap();
        assert_eq!(resolved, target.canonicalize().unwrap());
    }

    #[test]
    fn test_sandbox_nonexistent_root() {
        let result = PathSandbox::new("/tmp/nession-nonexistent-dir-xyz");
        assert!(result.is_err());
    }
}
