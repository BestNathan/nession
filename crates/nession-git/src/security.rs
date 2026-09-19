//! Path and output boundaries for the git capability (#750 C2, C3).
//!
//! The repository is chosen **agent-side**, from the Session's working
//! directory. The client never supplies it: a request that could name its own
//! `-C` would turn a Workspace view into a filesystem browser with the agent's
//! uid. So the only thing the client may name is a *relative* path inside that
//! repository, and this module is where that claim is checked.

use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Result};

/// Ceiling on `git status --porcelain=v2 -z` output. A status line is ~100
/// bytes; this is room for a few thousand changed paths, well past any working
/// directory a person is reading by eye.
pub const MAX_STATUS_BYTES: usize = 512 * 1024;

/// Ceiling on one file's diff. Reached routinely — a lockfile or a generated
/// bundle passes it in one file — which is why truncation is reported rather
/// than treated as an error.
pub const MAX_DIFF_BYTES: usize = 1024 * 1024;

/// Ceiling on `rev-parse` style one-line answers.
pub const MAX_LINE_BYTES: usize = 8 * 1024;

/// Validate a client-supplied repository-relative path.
///
/// Returns the path normalised to forward slashes, suitable for handing to git.
/// Rejects anything that could name a location outside the repository: absolute
/// paths, any `..` component, and Windows-style prefixes. `git` itself would
/// also refuse most of these, but the point is that this capability is not
/// allowed to *try* — the boundary is checked before a process is spawned.
pub fn validate_repo_relative_path(candidate: &str) -> Result<String> {
    let trimmed = candidate.trim();
    if trimmed.is_empty() {
        bail!("path is empty");
    }
    if trimmed.contains('\0') {
        bail!("path contains a NUL byte");
    }

    let path = Path::new(trimmed);
    if path.is_absolute() {
        bail!("path must be relative to the repository, got an absolute path");
    }

    for component in path.components() {
        match component {
            Component::Normal(_) => {}
            Component::CurDir => {}
            Component::ParentDir => bail!("path must not contain `..`"),
            Component::RootDir | Component::Prefix(_) => {
                bail!("path must be relative to the repository")
            }
        }
    }

    // Normalise separators so the same file is one string whatever the client
    // sent, and so `a//b` and `./a/b` do not look like three different paths.
    let parts: Vec<&str> = path
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect();
    if parts.is_empty() {
        bail!("path does not name a file");
    }
    Ok(parts.join("/"))
}

/// Join a relative path onto the repository root, asserting the result is
/// still inside it. Defence in depth: the check above is the real boundary,
/// this catches a caller that skipped it.
///
/// The join is **lexical**, not `Path::join`: joining and then asking
/// `starts_with` is not a check at all, because `/repo/../escape` still starts
/// with `/repo` as a sequence of components. `..` is therefore resolved here,
/// popping one component at a time and refusing to pop past the root — which is
/// what makes the assertion meaningful.
pub fn resolve_within(root: &Path, relative: &str) -> Result<PathBuf> {
    let mut out = PathBuf::from(root);
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => out.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                // `pop` returning false means we were already at the filesystem
                // root, and the `starts_with` guard covers the case where it
                // succeeded but climbed above the repository.
                if !out.pop() || !out.starts_with(root) {
                    bail!("resolved path escapes the repository root");
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                bail!("path must be relative to the repository")
            }
        }
    }
    if !out.starts_with(root) {
        bail!("resolved path escapes the repository root");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_relative_paths() {
        assert_eq!(
            validate_repo_relative_path("src/main.rs").unwrap(),
            "src/main.rs"
        );
        assert_eq!(validate_repo_relative_path("./a/b.txt").unwrap(), "a/b.txt");
        assert_eq!(validate_repo_relative_path("a//b.txt").unwrap(), "a/b.txt");
    }

    #[test]
    fn rejects_escapes_and_absolutes() {
        for bad in ["/etc/passwd", "../outside", "a/../../b", "", "   ", "a\0b"] {
            assert!(
                validate_repo_relative_path(bad).is_err(),
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn non_ascii_names_survive() {
        // Paths are handed to git as bytes, not re-encoded; a name that is not
        // ASCII must come back unchanged rather than lossily converted.
        let name = "文档/笔记.md";
        assert_eq!(validate_repo_relative_path(name).unwrap(), name);
    }

    #[test]
    fn resolve_within_stays_under_root() {
        let root = Path::new("/repo");
        assert_eq!(
            resolve_within(root, "a/b").unwrap(),
            PathBuf::from("/repo/a/b")
        );
        assert!(resolve_within(root, "../escape").is_err());
    }
}
