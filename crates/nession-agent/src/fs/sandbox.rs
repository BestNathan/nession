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
    /// Returns the resolved path; existing components are canonicalized.
    /// Returns an error with code `permission_denied` if the resolved
    /// path lies outside the root.
    pub fn resolve(&self, path: &str) -> Result<PathBuf> {
        // Normalize: strip leading '/' to make it relative to root
        let relative = path.trim_start_matches('/');
        let combined = self.root.join(relative);

        // Early-detection heuristic for `..` traversal attempts.
        // This catches obvious escapes before touching the filesystem,
        // but the real security guarantee is the canonicalize +
        // starts_with check below.
        let normalized = normalize_path(&combined);
        if !normalized.starts_with(&self.root) {
            anyhow::bail!("permission_denied: path outside sandbox root");
        }

        // Canonicalize unconditionally — avoids a TOCTOU race between
        // an explicit exists() check and the actual canonicalization.
        let resolved = match std::fs::canonicalize(&combined) {
            Ok(p) => p,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // Walk up the ancestor chain to find the first existing
                // directory, then append the non-existent suffix.
                // This handles paths like "a/b/c" where none of the
                // components exist yet (common for create_dir, write_file).
                //
                // NOTE: Use `Option<PathBuf>` for suffix to avoid
                // `join(empty_path)` on macOS, which spuriously adds a
                // trailing slash (e.g. `"a".join("")` → `"a/"`).
                let mut ancestor = combined.as_path();
                let mut suffix: Option<PathBuf> = None;
                loop {
                    match std::fs::canonicalize(ancestor) {
                        Ok(canonical) => {
                            if !canonical.starts_with(&self.root) {
                                anyhow::bail!("permission_denied: path outside sandbox root");
                            }
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
            Err(e) => return Err(anyhow::Error::from(e)).context("failed to resolve path"),
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

/// Early-detection heuristic: resolve `.` and `..` components without
/// touching the filesystem.
///
/// This provides a **logical** (not canonical) normalization useful for
/// detecting obvious directory traversal attempts before filesystem
/// operations are attempted.  It is NOT a security boundary — the real
/// guarantee comes from `canonicalize` + `starts_with` after resolution.
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
    fn test_resolve_rejects_dot_dot_escape() {
        let (_dir, sandbox) = setup_sandbox();
        let result = sandbox.resolve("../etc/passwd");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("permission_denied") || err.contains("outside sandbox"));
    }

    #[test]
    fn test_resolve_absolute_path_strips_leading_slash() {
        let (dir, sandbox) = setup_sandbox();
        // Leading `/` is stripped, so `/etc/passwd` → `etc/passwd`
        // relative to sandbox root. This is an in-sandbox non-existent path,
        // so it resolves successfully to `<root>/etc/passwd`.
        let result = sandbox.resolve("/etc/passwd").unwrap();
        let expected = dir.path().canonicalize().unwrap().join("etc/passwd");
        assert_eq!(result, expected);
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
